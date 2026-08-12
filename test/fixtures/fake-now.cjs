"use strict";

const target = process.env.CCCN_TEST_FAKE_NOW;
if (target) {
  const RealDate = Date;
  const targetMs = RealDate.parse(target);
  if (!Number.isNaN(targetMs)) {
    const offsetMs = targetMs - RealDate.now();

    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) {
          super(RealDate.now() + offsetMs);
        } else {
          super(...args);
        }
      }

      static now() {
        return RealDate.now() + offsetMs;
      }
    }

    globalThis.Date = FakeDate;
  }
}
