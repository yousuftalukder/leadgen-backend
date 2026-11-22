// Phase 84, from the Owner Assistant (its v2.25.0): a phone number is a country code and the number, in two fields,
// checked. It is kept as "+<code> <digits>" in the one phone column. The same file runs in the page (window.PHONE)
// and on the server (require), so the two always agree on what a valid number is.
(function (root) {
  'use strict';
  // [ISO code, name, calling code]. Bangladesh first (most of the businesses are there), the United States next,
  // then A–Z. Countries that share a code (the US and Canada on +1, Russia and Kazakhstan on +7) are all listed;
  // a saved number is shown under the first of them.
  const COUNTRIES = [
    ['BD', 'Bangladesh', '880'], ['US', 'United States', '1'],
    ['AF', 'Afghanistan', '93'], ['AL', 'Albania', '355'], ['DZ', 'Algeria', '213'], ['AD', 'Andorra', '376'],
    ['AO', 'Angola', '244'], ['AR', 'Argentina', '54'], ['AM', 'Armenia', '374'], ['AU', 'Australia', '61'],
    ['AT', 'Austria', '43'], ['AZ', 'Azerbaijan', '994'], ['BH', 'Bahrain', '973'],
    ['BY', 'Belarus', '375'], ['BE', 'Belgium', '32'], ['BZ', 'Belize', '501'], ['BJ', 'Benin', '229'],
    ['BT', 'Bhutan', '975'], ['BO', 'Bolivia', '591'], ['BA', 'Bosnia and Herzegovina', '387'], ['BW', 'Botswana', '267'],
    ['BR', 'Brazil', '55'], ['BN', 'Brunei', '673'], ['BG', 'Bulgaria', '359'], ['BF', 'Burkina Faso', '226'],
    ['BI', 'Burundi', '257'], ['KH', 'Cambodia', '855'], ['CM', 'Cameroon', '237'], ['CA', 'Canada', '1'],
    ['CV', 'Cape Verde', '238'], ['CF', 'Central African Republic', '236'], ['TD', 'Chad', '235'], ['CL', 'Chile', '56'],
    ['CN', 'China', '86'], ['CO', 'Colombia', '57'], ['KM', 'Comoros', '269'], ['CG', 'Congo', '242'],
    ['CD', 'Congo (DRC)', '243'], ['CR', 'Costa Rica', '506'], ['CI', "Côte d'Ivoire", '225'], ['HR', 'Croatia', '385'],
    ['CU', 'Cuba', '53'], ['CY', 'Cyprus', '357'], ['CZ', 'Czechia', '420'], ['DK', 'Denmark', '45'],
    ['DJ', 'Djibouti', '253'], ['EC', 'Ecuador', '593'], ['EG', 'Egypt', '20'], ['SV', 'El Salvador', '503'],
    ['GQ', 'Equatorial Guinea', '240'], ['ER', 'Eritrea', '291'], ['EE', 'Estonia', '372'], ['SZ', 'Eswatini', '268'],
    ['ET', 'Ethiopia', '251'], ['FJ', 'Fiji', '679'], ['FI', 'Finland', '358'], ['FR', 'France', '33'],
    ['GA', 'Gabon', '241'], ['GM', 'Gambia', '220'], ['GE', 'Georgia', '995'], ['DE', 'Germany', '49'],
    ['GH', 'Ghana', '233'], ['GR', 'Greece', '30'], ['GT', 'Guatemala', '502'], ['GN', 'Guinea', '224'],
    ['GW', 'Guinea-Bissau', '245'], ['GY', 'Guyana', '592'], ['HT', 'Haiti', '509'], ['HN', 'Honduras', '504'],
    ['HK', 'Hong Kong', '852'], ['HU', 'Hungary', '36'], ['IS', 'Iceland', '354'], ['IN', 'India', '91'],
    ['ID', 'Indonesia', '62'], ['IR', 'Iran', '98'], ['IQ', 'Iraq', '964'], ['IE', 'Ireland', '353'],
    ['IL', 'Israel', '972'], ['IT', 'Italy', '39'], ['JP', 'Japan', '81'], ['JO', 'Jordan', '962'],
    ['KZ', 'Kazakhstan', '7'], ['KE', 'Kenya', '254'], ['KW', 'Kuwait', '965'], ['KG', 'Kyrgyzstan', '996'],
    ['LA', 'Laos', '856'], ['LV', 'Latvia', '371'], ['LB', 'Lebanon', '961'], ['LS', 'Lesotho', '266'],
    ['LR', 'Liberia', '231'], ['LY', 'Libya', '218'], ['LI', 'Liechtenstein', '423'], ['LT', 'Lithuania', '370'],
    ['LU', 'Luxembourg', '352'], ['MO', 'Macau', '853'], ['MG', 'Madagascar', '261'], ['MW', 'Malawi', '265'],
    ['MY', 'Malaysia', '60'], ['MV', 'Maldives', '960'], ['ML', 'Mali', '223'], ['MT', 'Malta', '356'],
    ['MR', 'Mauritania', '222'], ['MU', 'Mauritius', '230'], ['MX', 'Mexico', '52'], ['MD', 'Moldova', '373'],
    ['MC', 'Monaco', '377'], ['MN', 'Mongolia', '976'], ['ME', 'Montenegro', '382'], ['MA', 'Morocco', '212'],
    ['MZ', 'Mozambique', '258'], ['MM', 'Myanmar', '95'], ['NA', 'Namibia', '264'], ['NP', 'Nepal', '977'],
    ['NL', 'Netherlands', '31'], ['NZ', 'New Zealand', '64'], ['NI', 'Nicaragua', '505'], ['NE', 'Niger', '227'],
    ['NG', 'Nigeria', '234'], ['MK', 'North Macedonia', '389'], ['NO', 'Norway', '47'], ['OM', 'Oman', '968'],
    ['PK', 'Pakistan', '92'], ['PS', 'Palestine', '970'], ['PA', 'Panama', '507'], ['PG', 'Papua New Guinea', '675'],
    ['PY', 'Paraguay', '595'], ['PE', 'Peru', '51'], ['PH', 'Philippines', '63'], ['PL', 'Poland', '48'],
    ['PT', 'Portugal', '351'], ['QA', 'Qatar', '974'], ['RO', 'Romania', '40'], ['RU', 'Russia', '7'],
    ['RW', 'Rwanda', '250'], ['SA', 'Saudi Arabia', '966'], ['SN', 'Senegal', '221'], ['RS', 'Serbia', '381'],
    ['SC', 'Seychelles', '248'], ['SL', 'Sierra Leone', '232'], ['SG', 'Singapore', '65'], ['SK', 'Slovakia', '421'],
    ['SI', 'Slovenia', '386'], ['SO', 'Somalia', '252'], ['ZA', 'South Africa', '27'], ['KR', 'South Korea', '82'],
    ['SS', 'South Sudan', '211'], ['ES', 'Spain', '34'], ['LK', 'Sri Lanka', '94'], ['SD', 'Sudan', '249'],
    ['SR', 'Suriname', '597'], ['SE', 'Sweden', '46'], ['CH', 'Switzerland', '41'], ['SY', 'Syria', '963'],
    ['TW', 'Taiwan', '886'], ['TJ', 'Tajikistan', '992'], ['TZ', 'Tanzania', '255'], ['TH', 'Thailand', '66'],
    ['TL', 'Timor-Leste', '670'], ['TG', 'Togo', '228'], ['TN', 'Tunisia', '216'], ['TR', 'Türkiye', '90'],
    ['TM', 'Turkmenistan', '993'], ['UG', 'Uganda', '256'], ['UA', 'Ukraine', '380'], ['AE', 'United Arab Emirates', '971'],
    ['GB', 'United Kingdom', '44'], ['UY', 'Uruguay', '598'], ['UZ', 'Uzbekistan', '998'], ['VE', 'Venezuela', '58'],
    ['VN', 'Vietnam', '84'], ['YE', 'Yemen', '967'], ['ZM', 'Zambia', '260'], ['ZW', 'Zimbabwe', '263'],
  ];
  // Digits after the country code, where the length is fixed or narrow. Anywhere else: 6 to 13, and never more
  // than 15 in all (the world limit, ITU E.164).
  const LENGTHS = {
    1: [10, 10], 7: [10, 10], 20: [9, 10], 27: [9, 9], 30: [10, 10], 31: [9, 9], 32: [8, 9], 33: [9, 9], 34: [9, 9],
    36: [8, 9], 39: [6, 11], 40: [9, 9], 41: [9, 9], 44: [9, 10], 45: [8, 8], 46: [7, 10], 47: [8, 8], 48: [9, 9],
    49: [6, 13], 52: [10, 10], 55: [10, 11], 56: [9, 9], 60: [8, 10], 61: [9, 9], 62: [8, 12], 63: [8, 10], 64: [8, 10],
    65: [8, 8], 66: [8, 9], 81: [9, 10], 82: [8, 10], 84: [9, 10], 86: [9, 11], 90: [10, 10], 91: [10, 10], 92: [9, 10],
    94: [9, 9], 852: [8, 8], 853: [8, 8], 880: [10, 10], 886: [8, 9], 966: [9, 9], 971: [8, 9], 972: [8, 9], 977: [8, 10],
  };
  const byIso = (iso) => COUNTRIES.find((c) => c[0] === iso) || COUNTRIES[0];
  const byCode = (code) => COUNTRIES.find((c) => c[2] === code) || null;

  // A saved value, old or new, back into its two fields. "+1 5084145532" and "+15084145532" both work; a number
  // saved before phase 84 without a code ("01712345678", as it was typed) is read as a Bangladesh number.
  function parse(value) {
    const s = String(value || '').trim();
    if (!s) return { iso: 'BD', national: '' };
    const digits = s.replace(/\D/g, '');
    if (s.startsWith('+')) {
      for (const len of [3, 2, 1]) {
        const c = byCode(digits.slice(0, len));
        if (c) return { iso: c[0], national: digits.slice(len) };
      }
      return { iso: 'BD', national: digits };
    }
    if (digits.length === 11 && digits.startsWith('01')) return { iso: 'BD', national: digits.slice(1) };
    return { iso: 'BD', national: digits };
  }

  // The two fields, checked. Spaces, dashes, dots and brackets are fine; anything else is not. A leading 0 (how
  // a number is dialled inside many countries) is dropped, except in Italy where it belongs to the number; a
  // US number typed with its leading 1 loses it. An empty number is allowed: the phone is optional.
  function check(iso, raw) {
    const c = byIso(iso), code = c[2], name = c[1];
    const typed = String(raw || '').trim();
    if (!typed) return { ok: true, value: null };
    if (/[^\d\s\-().]/.test(typed)) return { ok: false, error: 'Use only digits for the number. The country code goes in the box beside it.' };
    let digits = typed.replace(/\D/g, '');
    if (code === '1' && digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
    if (code !== '1' && code !== '39' && digits[0] === '0') digits = digits.slice(1);
    const [min, max] = LENGTHS[code] || [6, Math.min(13, 15 - code.length)];
    if (digits.length < min || digits.length > max) {
      return { ok: false, error: min === max ? `A number in ${name} has ${min} digits after +${code}.` : `A number in ${name} has ${min} to ${max} digits after +${code}.` };
    }
    if (code === '1' && /^[01]/.test(digits)) return { ok: false, error: `A number in ${name} cannot start with 0 or 1 after +1.` };
    return { ok: true, value: `+${code} ${digits}` };
  }

  // The server's door: a whole value as it arrives (from the two fields, from the staff workspace's single field,
  // or from a page opened before v2.25.0). Returns { ok, value } or { ok: false, error }.
  function normalize(value) {
    const s = String(value || '').trim();
    if (!s) return { ok: true, value: null };
    const p = parse(s);
    if (!s.startsWith('+') && p.national.length !== 10) return { ok: false, error: 'Please add the country code to the phone number, for example +880.' };
    return check(p.iso, p.national);
  }

  const api = { COUNTRIES, LENGTHS, parse, check, normalize };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PHONE = api;
})(typeof window !== 'undefined' ? window : globalThis);
