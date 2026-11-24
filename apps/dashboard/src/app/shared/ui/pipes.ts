import { Pipe, type PipeTransform } from '@angular/core';

/** First 8 characters of a commit SHA. */
@Pipe({ name: 'shortSha' })
export class ShortShaPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return value ? value.slice(0, 8) : '—';
  }
}

/** US dollars with precision suited to AI costs (sub-cent values stay visible). */
@Pipe({ name: 'usd' })
export class UsdPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }
}

/** Compact integer formatting: 12 345 → "12,345", 1 234 567 → "1.2M". */
@Pipe({ name: 'count' })
export class CountPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return new Intl.NumberFormat('en-US', { notation: value >= 1_000_000 ? 'compact' : 'standard' }).format(value);
  }
}

/** "false_positive" → "false positive". */
@Pipe({ name: 'humanize' })
export class HumanizePipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return value ? value.toLowerCase().replace(/_/g, ' ') : '';
  }
}

/** 0.873 → "87%". */
@Pipe({ name: 'percent0' })
export class Percent0Pipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
  }
}
