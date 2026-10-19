// Test preload: moves "now" forward by CLOCK_SHIFT_DAYS (default 0 = off).
// Explicit dates (new Date("2026-10-19")) are untouched, so a test that pins its
// clock passes at any shift, and one that reads the real clock against a fixed
// fixture date shows up as a failure. CI runs the suite at +30 and +120 days
// (2026-10-19: tests/autopilot-hold.test.ts turned PR #29 red by the calendar alone).
const days = Number(process.env.CLOCK_SHIFT_DAYS ?? 0);
if (Number.isFinite(days) && days !== 0) {
  const shift = days * 86_400_000;
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ShiftedDate;
}
