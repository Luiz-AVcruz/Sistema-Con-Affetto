import { Component, computed, input } from '@angular/core';
import type { Day } from '@caixa/shared';
import { formatMoney } from '../../core/money';

@Component({ selector: 'app-day-summary', standalone: true, templateUrl: './day-summary.component.html' })
export class DaySummaryComponent {
  readonly day = input.required<Day>();
  readonly summary = computed(() => this.day().adjustedSummary ?? this.day().summary);
  readonly money = formatMoney;
}
