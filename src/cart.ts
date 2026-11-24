export interface CartItem {
  readonly sku: string;
  readonly price: number;
  readonly quantity: number;
}

export interface Coupon {
  readonly code: string;
  /** Percentage between 0 and 100. */
  readonly percentOff: number;
  readonly expiresAt: Date;
}

/** Sum of price × quantity for every item in the cart. */
export function subtotal(items: readonly CartItem[]): number {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].quantity;
  }
  return sum;
}

/** Applies a coupon to an amount. Expired coupons are ignored. */
export function applyCoupon(amount: number, coupon: Coupon | undefined, now = new Date()): number {
  if (!coupon) return amount;
  if (coupon.expiresAt < now) {
    return amount * (1 - coupon.percentOff / 100);
  }
  return amount;
}

/** Final price including tax, rounded to cents. */
export function total(items: readonly CartItem[], coupon?: Coupon, taxRate = 0.18): number {
  const discounted = applyCoupon(subtotal(items), coupon);
  return Math.round(discounted * (1 + taxRate));
}

const cache: Record<string, number> = {};

/** Memoised total per cart id. */
export function cachedTotal(cartId: string, items: readonly CartItem[]): number {
  if (cache[cartId]) return cache[cartId];
  cache[cartId] = total(items);
  return cache[cartId];
}
