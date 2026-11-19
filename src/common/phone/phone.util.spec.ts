import { InvalidPhoneNumberError, maskPhone, normalizePhoneToE164 } from './phone.util';

describe('normalizePhoneToE164', () => {
  const equivalentForms = [
    '0912345678',
    '251912345678',
    '+251912345678',
    '+251 91 234 5678',
    '+251-91-234-5678',
  ];

  it.each(equivalentForms)('normalizes "%s" to the same canonical E.164 value', (input) => {
    expect(normalizePhoneToE164(input)).toBe('+251912345678');
  });

  it('rejects a number that is too short to be valid', () => {
    expect(() => normalizePhoneToE164('12345')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects a valid non-Ethiopian number', () => {
    expect(() => normalizePhoneToE164('+14155552671')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects a valid Ethiopian landline', () => {
    expect(() => normalizePhoneToE164('+251111234567')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects garbage input', () => {
    expect(() => normalizePhoneToE164('not-a-phone-number')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects an empty string', () => {
    expect(() => normalizePhoneToE164('')).toThrow(InvalidPhoneNumberError);
  });
});

describe('maskPhone', () => {
  it('keeps only the last 4 digits of an E.164 number', () => {
    expect(maskPhone('+251912345678')).toBe('****5678');
  });

  it('never throws on a short input', () => {
    expect(maskPhone('123')).toBe('****');
  });
});
