export function productCacheKey(productId: number): string {
  return `product:${productId}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
