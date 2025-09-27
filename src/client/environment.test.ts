import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  patchMath,
  createDeterministicDate,
  createConsole,
} from "./environment.js";

describe("environment patching units", () => {
  describe("patchMath", () => {
    it("should preserve all Math methods except random", () => {
      const originalMath = Math;
      const patchedMath = patchMath(originalMath);

      // Should preserve all other methods
      expect(patchedMath.abs).toBe(originalMath.abs);
      expect(patchedMath.sin).toBe(originalMath.sin);
      expect(patchedMath.cos).toBe(originalMath.cos);
      expect(patchedMath.PI).toBe(originalMath.PI);
      expect(patchedMath.E).toBe(originalMath.E);
    });

    it("should replace Math.random with function that throws", () => {
      const originalMath = Math;
      const patchedMath = patchMath(originalMath);

      expect(() => patchedMath.random()).toThrow(
        "Math.random() isn't currently supported within workflows",
      );
    });

    it("should not mutate the original Math object", () => {
      const originalMath = Math;
      const originalRandom = Math.random;

      patchMath(originalMath);

      // Original Math should be unchanged
      expect(Math.random).toBe(originalRandom);
    });
  });

  describe("createDeterministicDate", () => {
    const mockGetGenerationState = vi.fn();

    beforeEach(() => {
      mockGetGenerationState.mockReturnValue({
        now: 1234567890000,
        latest: true,
      });
    });

    afterEach(() => {
      mockGetGenerationState.mockReset();
    });

    it("should create Date that uses generation state for Date.now()", () => {
      const testTime = 9876543210000;
      mockGetGenerationState.mockReturnValue({ now: testTime, latest: true });

      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );

      expect(DeterministicDate.now()).toBe(testTime);
      expect(mockGetGenerationState).toHaveBeenCalled();
    });

    it("should create new Date with current timestamp when no args", () => {
      const testTime = 1111111111111;
      mockGetGenerationState.mockReturnValue({ now: testTime, latest: true });

      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );
      const date = new DeterministicDate();

      expect(date.getTime()).toBe(testTime);
    });

    it("should create Date with provided args", () => {
      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );
      const date = new DeterministicDate(2023, 0, 1);

      expect(date.getFullYear()).toBe(2023);
      expect(date.getMonth()).toBe(0);
      expect(date.getDate()).toBe(1);
    });

    it("should return string when called without new", () => {
      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );

      const dateString = (DeterministicDate as unknown as () => string)();
      expect(typeof dateString).toBe("string");
    });

    it("should preserve original Date static methods", () => {
      const originalDate = Date;
      const DeterministicDate = createDeterministicDate(
        originalDate,
        mockGetGenerationState,
      );

      expect(DeterministicDate.parse).toBe(originalDate.parse);
      expect(DeterministicDate.UTC).toBe(originalDate.UTC);
      expect(DeterministicDate.prototype).toBe(originalDate.prototype);
    });

    it("should not affect the original Date constructor", () => {
      const originalNow = Date.now;

      createDeterministicDate(Date, mockGetGenerationState);

      // Original Date should be unchanged
      expect(Date.now).toBe(originalNow);
    });
  });

  describe("createConsole", () => {
    const mockGetGenerationState = vi.fn();
    let mockConsole: {
      log: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
      debug: ReturnType<typeof vi.fn>;
      group: ReturnType<typeof vi.fn>;
      groupEnd: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockConsole = {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        group: vi.fn(),
        groupEnd: vi.fn(),
      };
    });

    afterEach(() => {
      mockGetGenerationState.mockReset();
    });

    it("should allow console methods when latest is true", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.log("test");
      proxiedConsole.info("test");
      proxiedConsole.warn("test");
      proxiedConsole.error("test");

      expect(mockConsole.log).toHaveBeenCalledWith("test");
      expect(mockConsole.info).toHaveBeenCalledWith("test");
      expect(mockConsole.warn).toHaveBeenCalledWith("test");
      expect(mockConsole.error).toHaveBeenCalledWith("test");
    });

    it("should return noop function when latest is false", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: false });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      // Methods should be functions (noop) but not call the original
      expect(typeof proxiedConsole.log).toBe("function");
      expect(typeof proxiedConsole.info).toBe("function");

      proxiedConsole.log("test");
      proxiedConsole.info("test");

      expect(mockConsole.log).not.toHaveBeenCalled();
      expect(mockConsole.info).not.toHaveBeenCalled();
    });

    it("should throw error for console.Console access", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      expect(() => proxiedConsole.Console).toThrow(
        "console.Console() is not supported within workflows",
      );
    });

    it("should handle console.count with state tracking", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.count("test");
      proxiedConsole.count("test");
      proxiedConsole.count(); // default label

      expect(mockConsole.info).toHaveBeenCalledWith("test: 1");
      expect(mockConsole.info).toHaveBeenCalledWith("test: 2");
      expect(mockConsole.info).toHaveBeenCalledWith("default: 1");
    });

    it("should handle console.countReset", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.count("test");
      proxiedConsole.count("test");
      proxiedConsole.countReset("test");
      proxiedConsole.count("test");

      expect(mockConsole.info).toHaveBeenCalledWith("test: 1");
      expect(mockConsole.info).toHaveBeenCalledWith("test: 2");
      expect(mockConsole.info).toHaveBeenCalledWith("test: 1");
    });

    it("should always pass through groupEnd", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: false });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.groupEnd();
      expect(mockConsole.groupEnd).toHaveBeenCalled();
    });

    it("should handle time/timeEnd with generation state", () => {
      const startTime = 1000;
      const endTime = 1500;

      // Mock different return values for different calls
      mockGetGenerationState
        .mockReturnValueOnce({ now: startTime, latest: false }) // for time()
        .mockReturnValueOnce({ now: endTime, latest: true }); // for timeEnd()

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.time("test");
      proxiedConsole.timeEnd("test");

      expect(mockConsole.info).toHaveBeenCalledWith("test: 500ms");
    });

    it("should not call console methods for count when latest is false", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: false });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.count("test");
      proxiedConsole.count("test");

      // Should not call info when latest is false
      expect(mockConsole.info).not.toHaveBeenCalled();
    });
  });
});
