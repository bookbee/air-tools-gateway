import type { Clock } from "../../src/app.js";

/** A clock the test moves by hand: expiry is tested without sleeping. */
export class TestClock implements Clock {
  #ms: number;

  constructor(start = "2026-11-14T10:02:11.000Z") {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(seconds: number): void {
    this.#ms += seconds * 1000;
  }
}
