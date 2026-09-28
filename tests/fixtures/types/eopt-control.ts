// Type-only fixture, never executed. The control for
// `tests/consumer-types.spec.ts`: with the flag off this compiles, and with
// `exactOptionalPropertyTypes` on it must report exactly one TS2375 on the
// `control` line. That proves the spec really compiles with the flag.
interface Exact {
  value?: string;
}

declare const maybe: string | undefined;

export const control: Exact = { value: maybe };
