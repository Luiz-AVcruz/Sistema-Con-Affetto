import { Component, inject, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CashStore } from './core/cash.store';
import { SalesComponent } from './features/sales/sales.component';
import { ProductsComponent } from './features/products/products.component';
import { ClosingComponent } from './features/closing/closing.component';
import { HistoryComponent } from './features/history/history.component';
import { FairsComponent } from './features/fairs/fairs.component';
import { WorkspaceStore } from './core/workspace.store';
import { workspaceViews } from '@caixa/shared';

@Component({ selector: 'app-root', standalone: true, imports: [FormsModule, SalesComponent, ProductsComponent, ClosingComponent, HistoryComponent, FairsComponent], templateUrl: './app.component.html' })
export class AppComponent {
  readonly store = inject(CashStore);
  readonly workspace = inject(WorkspaceStore);
  readonly view = this.workspace.view;
  readonly views = workspaceViews;
  @ViewChild(SalesComponent) private sales?: SalesComponent;
  constructor() { void this.workspace.initialize(); }
  saveFile(): void {
    if (this.store.busy() || this.workspace.candidate()) return;
    if (this.sales && !this.sales.persist()) return;
    void this.workspace.save();
  }
  selectFile(event: Event): void {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (file) void this.workspace.inspect(file);
  }
  importFile(): void {
    if (this.sales && !this.sales.persist()) return;
    void this.workspace.confirmImport();
  }
}
