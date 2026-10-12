import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { FormsModule } from '@angular/forms';
import type { Product } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatMoney, moneyInput, parseMoney } from '../../core/money';
import { matchesSearch } from '../../core/search';

@Component({ selector: 'app-products', standalone: true, imports: [ReactiveFormsModule, FormsModule], templateUrl: './products.component.html' })
export class ProductsComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly search = signal('');
  readonly filter = signal<'all' | 'active' | 'inactive' | 'out-of-stock'>('all');
  readonly filtered = computed(() => (this.store.data()?.products ?? []).filter(product => {
    const filter = this.filter();
    return (filter === 'all' || filter === 'active' && product.active || filter === 'inactive' && !product.active
      || filter === 'out-of-stock' && product.stock === 0)
      && matchesSearch(`${product.name} ${product.ownerName} ${product.description}`, this.search());
  }));
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(100)]], description: ['', Validators.maxLength(200)],
    ownerId: [0, Validators.min(1)], price: ['', Validators.required], stock: [''], active: [true]
  });
  editId?: number;
  private editVersion?: number;
  ownerName = '';
  edit(product: Product): void {
    this.editId = product.id;
    this.editVersion = product.version;
    this.form.setValue({ name: product.name, description: product.description, ownerId: product.ownerId,
      price: moneyInput(product.priceCents), stock: product.stock === null ? '' : String(product.stock), active: product.active });
  }
  clear(): void { this.editId = undefined; this.editVersion = undefined; this.form.reset({ ownerId: this.store.data()?.owners[0]?.id ?? 0, active: true }); }
  async save(): Promise<void> {
    if (this.form.invalid) { this.form.markAllAsTouched(); this.store.error.set('Preencha nome, participante e preço do produto.'); return; }
    try {
      const value = this.form.getRawValue();
      if (value.stock.trim() && !/^\d+$/.test(value.stock.trim())) throw new Error('Estoque deve ser um número inteiro ou ficar vazio para A contar.');
      const saved = await this.store.saveProduct({ name: value.name, description: value.description,
        ownerId: Number(value.ownerId), priceCents: parseMoney(value.price),
        stock: value.stock.trim() ? Number(value.stock) : null, active: value.active,
        ...(this.editId ? { expectedVersion: this.editVersion } : {}) }, this.editId);
      if (saved) this.clear();
    } catch (error) { this.store.report(error); }
  }
  async addOwner(): Promise<void> {
    if (!this.ownerName.trim()) return;
    if (await this.store.addOwner(this.ownerName)) this.ownerName = '';
  }
}
