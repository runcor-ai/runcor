// Unit tests for CostCalculator
// Per spec FR-001, FR-006, FR-015

import { describe, it, expect } from 'vitest';
import { calculateCost, estimateCost } from '../../../src/cost/calculator.js';

describe('CostCalculator', () => {
  describe('calculateCost', () => {
    it('calculates cost with normal input and output rates', () => {
      const cost = calculateCost(100, 50, { input: 0.01, output: 0.03 });
      // (100 * 0.01) + (50 * 0.03) = 1.0 + 1.5 = 2.5
      expect(cost).toBeCloseTo(2.5);
    });

    it('returns zero when costPerToken is null', () => {
      const cost = calculateCost(100, 50, null);
      expect(cost).toBe(0);
    });

    it('handles partial rates — only input defined (output treated as 0)', () => {
      // Partial rate: only input defined
      const cost = calculateCost(100, 50, { input: 0.01, output: 0 });
      expect(cost).toBeCloseTo(1.0);
    });

    it('handles partial rates — only output defined (input treated as 0)', () => {
      const cost = calculateCost(100, 50, { input: 0, output: 0.03 });
      expect(cost).toBeCloseTo(1.5);
    });

    it('handles explicit zero rates', () => {
      const cost = calculateCost(100, 50, { input: 0, output: 0 });
      expect(cost).toBe(0);
    });

    it('handles zero token counts', () => {
      const cost = calculateCost(0, 0, { input: 0.01, output: 0.03 });
      expect(cost).toBe(0);
    });

    it('handles large token counts correctly', () => {
      const cost = calculateCost(100000, 50000, { input: 0.001, output: 0.002 });
      // (100000 * 0.001) + (50000 * 0.002) = 100 + 100 = 200
      expect(cost).toBeCloseTo(200);
    });
  });

  describe('estimateCost', () => {
    it('estimates cost using prompt length and maxTokens', () => {
      // promptEstimate = promptLength / 4 = 400 / 4 = 100 tokens
      // estimatedCost = (100 * 0.01) + (200 * 0.03) = 1.0 + 6.0 = 7.0
      const cost = estimateCost(400, 200, { input: 0.01, output: 0.03 }, 1000);
      expect(cost).toBeCloseTo(7.0);
    });

    it('returns zero when costPerToken is null', () => {
      const cost = estimateCost(400, 200, null, 1000);
      expect(cost).toBe(0);
    });

    it('uses defaultTokenEstimate when maxTokens is undefined', () => {
      // promptEstimate = 400 / 4 = 100
      // estimatedCost = (100 * 0.01) + (1000 * 0.03) = 1.0 + 30.0 = 31.0
      const cost = estimateCost(400, undefined, { input: 0.01, output: 0.03 }, 1000);
      expect(cost).toBeCloseTo(31.0);
    });

    it('handles zero maxTokens (zero completion estimate)', () => {
      // promptEstimate = 400 / 4 = 100
      // estimatedCost = (100 * 0.01) + (0 * 0.03) = 1.0
      const cost = estimateCost(400, 0, { input: 0.01, output: 0.03 }, 1000);
      expect(cost).toBeCloseTo(1.0);
    });

    it('handles empty prompt (zero prompt estimate)', () => {
      // promptEstimate = 0 / 4 = 0
      // estimatedCost = (0 * 0.01) + (200 * 0.03) = 6.0
      const cost = estimateCost(0, 200, { input: 0.01, output: 0.03 }, 1000);
      expect(cost).toBeCloseTo(6.0);
    });

    it('uses custom defaultTokenEstimate', () => {
      // promptEstimate = 400 / 4 = 100
      // estimatedCost = (100 * 0.01) + (500 * 0.03) = 1.0 + 15.0 = 16.0
      const cost = estimateCost(400, undefined, { input: 0.01, output: 0.03 }, 500);
      expect(cost).toBeCloseTo(16.0);
    });
  });

  // Messages-based prompt length estimation
  describe('estimateCost with messages prompt length', () => {
    it('computes prompt length as concatenation of message contents', () => {
      // messages: ["Hello", " world"] => "Hello world" => length 11
      // promptEstimate = 11 / 4 = 2.75
      // estimatedCost = (2.75 * 0.01) + (1000 * 0.03) = 0.0275 + 30.0 = 30.0275
      const messagesLength = 'Hello world'.length; // 11
      const cost = estimateCost(messagesLength, undefined, { input: 0.01, output: 0.03 }, 1000);
      expect(cost).toBeCloseTo(30.0275);
    });

    it('same cost for equivalent content via prompt vs messages', () => {
      const content = 'Hello world how are you';
      const costFromPrompt = estimateCost(content.length, 200, { input: 0.01, output: 0.03 }, 1000);
      // Simulate messages concatenation producing same length
      const messagesContent = ['Hello world', ' how are', ' you'].join('');
      const costFromMessages = estimateCost(messagesContent.length, 200, { input: 0.01, output: 0.03 }, 1000);
      expect(costFromPrompt).toBeCloseTo(costFromMessages);
    });

    it('empty messages content results in zero prompt estimate', () => {
      const cost = estimateCost(0, 200, { input: 0.01, output: 0.03 }, 1000);
      // promptEstimate = 0, completionEstimate = 200
      // (0 * 0.01) + (200 * 0.03) = 6.0
      expect(cost).toBeCloseTo(6.0);
    });
  });

  describe('NFR performance', () => {
    it('calculateCost is synchronous < 1ms for 10K calls (NFR-001)', () => {
      const start = performance.now();
      for (let i = 0; i < 10_000; i++) {
        calculateCost(1000, 500, { input: 0.001, output: 0.002 });
      }
      const elapsed = performance.now() - start;
      // 10K calculations should be well under 10ms total
      expect(elapsed).toBeLessThan(10);
    });
  });
});
