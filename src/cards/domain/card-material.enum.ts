/**
 * What a physical card is made of. Meaningless for a virtual card, which is why
 * `CardProduct.material` is nullable rather than defaulted.
 */
export enum CardMaterial {
  METAL = 'METAL',
  PLASTIC = 'PLASTIC',
}
