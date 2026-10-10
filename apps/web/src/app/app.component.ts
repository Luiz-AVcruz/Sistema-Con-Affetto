import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CashStore } from './core/cash.store';
import { SalesComponent } from './features/sales/sales.component';
import { ProductsComponent } from './features/products/products.component';
import { ClosingComponent } from './features/closing/closing.component';
import { HistoryComponent } from './features/history/history.component';

@Component({ selector: 'app-root', standalone: true, imports: [FormsModule, SalesComponent, ProductsComponent, ClosingComponent, HistoryComponent], templateUrl: './app.component.html' })
export class AppComponent {
  readonly store = inject(CashStore);
  readonly view = signal('Vender');
  readonly views = ['Vender', 'Produtos', 'Fechamento', 'Histórico'];
  constructor() { void this.store.refresh(); }
}
