import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CashStore } from './core/cash.store';
import { SalesComponent } from './features/sales/sales.component';
import { ProductsComponent } from './features/products/products.component';
import { ClosingComponent } from './features/closing/closing.component';
import { HistoryComponent } from './features/history/history.component';
import { FairsComponent } from './features/fairs/fairs.component';
import { SummaryComponent } from './features/summary/summary.component';

@Component({ selector: 'app-root', standalone: true, imports: [FormsModule, SalesComponent, ProductsComponent, ClosingComponent, HistoryComponent, FairsComponent, SummaryComponent], templateUrl: './app.component.html' })
export class AppComponent {
  readonly store = inject(CashStore);
  readonly view = signal('Vender');
  readonly views = ['Vender', 'Produtos', 'Fechamento', 'Sumário', 'Histórico', 'Feiras'];
  readonly historyDay = signal<{ fairId: number; date: string } | null>(null);
  readonly historyDate = computed(() => this.historyDay()?.fairId === this.store.data()?.fair.id ? this.historyDay()?.date ?? null : null);
  constructor() { void this.store.refresh(); }
  openView(view: string): void { this.historyDay.set(null); this.view.set(view); }
  showDayHistory(date: string): void {
    const data = this.store.data();
    if (!data?.closedDays.some(day => day.date === date)) return;
    this.historyDay.set({ fairId: data.fair.id, date });
    this.view.set('Histórico');
  }
}
