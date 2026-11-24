import { subtotal } from './cart';

describe('subtotal', () => {
  it('adds price × quantity', () => {
    expect(subtotal([{ sku: 'a', price: 10, quantity: 2 }])).toBe(20);
  });
});
