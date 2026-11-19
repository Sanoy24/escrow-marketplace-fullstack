import { InvalidMoneyInputError, parseEtbToSantim } from './parse-etb';

describe('parseEtbToSantim', () => {
  it.each([
    ['0', 0n],
    ['1', 100n],
    ['1500', 150000n],
    ['1500.5', 150050n],
    ['1500.50', 150050n],
    ['1500.05', 150005n],
    ['0.99', 99n],
  ])('parses "%s" to %s santim', (input, expected) => {
    expect(parseEtbToSantim(input)).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    expect(parseEtbToSantim('  1500.50  ')).toBe(150050n);
  });

  it.each([
    ['1500.555', 'more than 2 decimal places'],
    ['-100', 'negative'],
    ['1500abc', 'trailing garbage — the parseFloat failure mode this exists to prevent'],
    ['', 'empty string'],
    ['abc', 'non-numeric'],
    ['1e10', 'exponential notation'],
    ['NaN', 'the literal string NaN'],
    ['Infinity', 'the literal string Infinity'],
  ])('rejects "%s" (%s)', (input) => {
    expect(() => parseEtbToSantim(input)).toThrow(InvalidMoneyInputError);
  });
});
