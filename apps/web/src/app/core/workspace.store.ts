import { Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { parseWorkspaceState, type WorkspaceState, type WorkspaceInfo, type WorkspaceView, type SnapshotSummary } from '@caixa/shared';
import { CashStore } from './cash.store';
import { workspaceGeneration } from './workspace-generation';

const markerKey = 'caixa-feira-generation-v1';
const contextKey = 'caixa-feira-context-v1';
const isDraftKey = (key: string) => key === 'caixa-feira-draft-v1' || key.startsWith('caixa-feira-draft-v2-');
interface ImportCandidate { token: string; fingerprint: string; summary: SnapshotSummary }

@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  readonly cash = inject(CashStore);
  private readonly http = inject(HttpClient);
  readonly view = signal<WorkspaceView>('Vender');
  readonly candidate = signal<ImportCandidate | null>(null);
  readonly recovery = signal(false);
  private pendingImport: { operationId: string; generation: string | null | undefined } | null = null;

  constructor() {
    effect(() => {
      const context = { date: this.cash.date(), fairId: this.cash.selectedFairId(), view: this.view() };
      if (this.cash.workspaceBlocked()) return;
      try { localStorage.setItem(contextKey, JSON.stringify(context)); }
      catch { this.cash.error.set('Não foi possível guardar a tela e a data selecionadas neste computador.'); }
    });
  }

  private capture(): WorkspaceState {
    const drafts: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isDraftKey(key)) drafts[key] = localStorage.getItem(key)!;
    }
    return parseWorkspaceState({ version: 1, date: this.cash.date(), fairId: this.cash.selectedFairId(), view: this.view(), drafts });
  }

  private apply(workspace: WorkspaceInfo): void {
    this.cash.blockWorkspace();
    // O marcador vai por último. Uma interrupção ou falha de armazenamento
    // obriga a repetir toda a aplicação antes de montar os componentes de venda.
    localStorage.removeItem(markerKey);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key && isDraftKey(key));
    for (const key of keys) localStorage.removeItem(key);
    const state = parseWorkspaceState(workspace.state);
    for (const [key, value] of Object.entries(state.drafts)) localStorage.setItem(key, value);
    localStorage.setItem(contextKey, JSON.stringify({ date: state.date, fairId: state.fairId, view: state.view }));
    localStorage.setItem(markerKey, workspace.generation);
    this.cash.date.set(state.date); this.cash.selectedFairId.set(state.fairId); this.view.set(state.view);
    workspaceGeneration.set(workspace.generation);
  }

  async initialize(): Promise<void> {
    if (this.cash.fileBusy()) return;
    this.cash.fileBusy.set(true); this.cash.blockWorkspace();
    try {
      const { workspace } = await firstValueFrom(this.http.get<{ workspace: WorkspaceInfo | null }>('/api/workspace'));
      if (workspace && localStorage.getItem(markerKey) !== workspace.generation) this.apply(workspace);
      else {
        workspaceGeneration.set(workspace?.generation ?? null);
        const raw = localStorage.getItem(contextKey);
        if (raw) {
          try {
            const state = parseWorkspaceState({ version: 1, ...JSON.parse(raw), drafts: {} });
            this.cash.date.set(state.date); this.cash.selectedFairId.set(state.fairId); this.view.set(state.view);
          } catch { this.cash.notice.set('A tela selecionada anteriormente estava inválida. Os rascunhos foram preservados.'); }
        }
      }
      this.cash.workspaceBlocked.set(false); this.recovery.set(false);
      await this.cash.refresh();
    } catch (error) { this.recovery.set(true); this.cash.report(error); }
    finally { this.cash.fileBusy.set(false); }
  }

  async save(): Promise<void> {
    if (this.cash.busy()) return;
    this.cash.fileBusy.set(true); this.cash.error.set('');
    try {
      const state = this.capture();
      const saved = await firstValueFrom(this.http.post<{ token: string; workspace: WorkspaceInfo }>('/api/snapshot/prepare', { state }));
      workspaceGeneration.set(saved.workspace.generation);
      try { localStorage.setItem(markerKey, saved.workspace.generation); }
      catch (error) { this.cash.blockWorkspace(); this.recovery.set(true); throw error; }
      const link = document.createElement('a');
      link.href = `/api/snapshot/download/${saved.token}`; link.download = 'caixa-da-feira.caixa';
      document.body.appendChild(link); link.click(); link.remove();
      this.cash.notice.set('Arquivo completo preparado. Escolha o destino na janela Salvar.');
    } catch (error) { this.cash.report(error); }
    finally { this.cash.fileBusy.set(false); }
  }

  async inspect(file: File): Promise<void> {
    if (this.cash.busy()) return;
    this.cash.fileBusy.set(true); this.cash.error.set(''); this.cash.notice.set('');
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error('O arquivo excede o limite de 128 MiB.');
      const bytes = await file.arrayBuffer();
      const candidate = await firstValueFrom(this.http.post<ImportCandidate>('/api/snapshot/inspect', bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
      this.candidate.set(candidate);
    } catch (error) { this.cash.report(error); }
    finally { this.cash.fileBusy.set(false); }
  }

  async cancelImport(): Promise<void> {
    const candidate = this.candidate();
    if (!candidate || this.cash.fileBusy()) return;
    this.candidate.set(null);
    try { await firstValueFrom(this.http.delete(`/api/snapshot/inspect/${candidate.token}`, { body: {} })); }
    catch (error) { this.cash.report(error); }
  }

  async confirmImport(): Promise<void> {
    const candidate = this.candidate();
    if (!candidate || this.cash.busy()) return;
    this.cash.fileBusy.set(true); this.cash.error.set('');
    try {
      const state = this.capture(), operationId = crypto.randomUUID();
      this.pendingImport = { operationId, generation: workspaceGeneration() };
      this.cash.blockWorkspace();
      const workspace = await firstValueFrom(this.http.post<WorkspaceInfo>('/api/snapshot/import', { token: candidate.token, fingerprint: candidate.fingerprint, state, operationId }));
      await this.finishImport(workspace);
    } catch (error) {
      this.cash.report(error);
      if (this.pendingImport) await this.recoverImport();
    } finally { this.cash.fileBusy.set(false); }
  }

  private async finishImport(workspace: WorkspaceInfo): Promise<void> {
    this.apply(workspace);
    this.pendingImport = null; this.candidate.set(null); this.recovery.set(false);
    this.cash.workspaceBlocked.set(false);
    await this.cash.refresh();
    this.cash.notice.set(`Arquivo completo importado. Cópia anterior preservada em ${workspace.backupPath}.`);
  }

  async recoverImport(): Promise<void> {
    if (!this.pendingImport) { await this.initialize(); return; }
    try {
      const { workspace } = await firstValueFrom(this.http.get<{ workspace: WorkspaceInfo | null }>('/api/workspace'));
      if (this.pendingImport && workspace?.importId === this.pendingImport.operationId) { await this.finishImport(workspace); return; }
      if (this.pendingImport && (workspace?.generation ?? null) === this.pendingImport.generation) {
        this.pendingImport = null; this.cash.workspaceBlocked.set(false); this.recovery.set(false);
        await this.cash.refresh();
        return;
      }
      if (workspace) { await this.finishImport(workspace); return; }
      throw new Error('Não foi possível determinar o resultado da importação.');
    } catch (error) {
      this.cash.blockWorkspace(); this.recovery.set(true); this.cash.report(error);
    }
  }
}
