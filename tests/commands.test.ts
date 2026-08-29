import { topBarMenuPosition } from "../src/ui/commands";

describe("top bar quick menu positioning", () => {
  it("right-aligns the menu below the top-bar button", () => {
    const anchor = {
      getBoundingClientRect: () => ({ right: 1880, bottom: 42 }),
    };
    const event = {
      currentTarget: anchor,
      clientX: 1868,
      clientY: 24,
    } as unknown as MouseEvent;

    expect(topBarMenuPosition(event)).toEqual({
      x: 1880,
      y: 42,
      isLeft: true,
    });
  });

  it("falls back to pointer coordinates when no button bounds are available", () => {
    const event = {
      currentTarget: null,
      clientX: 1868,
      clientY: 24,
    } as MouseEvent;

    expect(topBarMenuPosition(event)).toEqual({
      x: 1868,
      y: 24,
      isLeft: true,
    });
  });
});
