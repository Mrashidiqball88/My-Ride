'use strict';

const LOCAL_LOCATIONS = [
  ['Gulberg', 'Lahore', 31.5100, 74.3500, 'Area'],
  ['Gulberg Main Boulevard', 'Lahore', 31.5152, 74.3547, 'Street'],
  ['Gulberg III', 'Lahore', 31.5140, 74.3520, 'Area'],
  ['Garden Town', 'Lahore', 31.4920, 74.3210, 'Area'],
  ['Garden Town Main Boulevard', 'Lahore', 31.4910, 74.3190, 'Street'],
  ['Green Town', 'Lahore', 31.4495, 74.2975, 'Area'],
  ['Gulshan-e-Ravi', 'Lahore', 31.5067, 74.2828, 'Area'],
  ['Garhi Shahu', 'Lahore', 31.5684, 74.3430, 'Area'],
  ['Guru Mangat Road', 'Lahore', 31.5293, 74.3547, 'Street'],
  ['Grand Trunk Road', 'Lahore', 31.5900, 74.3450, 'Street'],
  ['Packages Mall', 'Lahore', 31.4320, 74.2630, 'Landmark'],
  ['Emporium Mall', 'Lahore', 31.4697, 74.2728, 'Landmark'],
  ['Shalimar Hospital', 'Lahore', 31.5822, 74.3921, 'Landmark'],
  ['Children Hospital Lahore', 'Lahore', 31.5003, 74.3297, 'Landmark'],
  ['Chowk Yateem Khana', 'Lahore', 31.5089, 74.2817, 'Landmark'],
  ['Centaurus Mall', 'Islamabad', 33.7077, 73.0511, 'Landmark'],
  ['Safa Gold Mall', 'Islamabad', 33.7215, 73.0565, 'Landmark'],
  ['DHA Phase 5', 'Karachi', 24.8006, 67.0610, 'Area'],
  ['DHA Phase 6', 'Karachi', 24.7915, 67.0648, 'Area'],
  ['DHA Phase 8', 'Karachi', 24.7825, 67.0980, 'Area'],
  ['Defence Housing Authority', 'Karachi', 24.8138, 67.0300, 'Area'],
  ['Sialkot Cantt', 'Sialkot', 32.4927, 74.5310, 'Area'],
  ['Paris Road', 'Sialkot', 32.4950, 74.5430, 'Street'],
  ['Salamatpura', 'Lahore', 31.5967, 74.3701, 'Area'],
  ['Sabzazar', 'Lahore', 31.4941, 74.2775, 'Area'],
  ['Samanabad', 'Lahore', 31.5337, 74.2865, 'Area'],
  ['Shadbagh', 'Lahore', 31.5885, 74.3432, 'Area'],
  ['Shahdara', 'Lahore', 31.6200, 74.2875, 'Area'],
  ['Tajpura', 'Lahore', 31.5701, 74.3868, 'Area'],
  ['Township', 'Lahore', 31.4580, 74.3040, 'Area'],
  ['Tufailabad', 'Lahore', 31.5535, 74.3195, 'Area'],
  ['Thokar Niaz Baig', 'Lahore', 31.4300, 74.2510, 'Area'],
  ['Model Town', 'Lahore', 31.4800, 74.3250, 'Area'],
  ['Model Town Link Road', 'Lahore', 31.4826, 74.3268, 'Street'],
  ['DHA Phase 5', 'Lahore', 31.4697, 74.4087, 'Area'],
  ['DHA Phase 6', 'Lahore', 31.4628, 74.4120, 'Area'],
  ['DHA Phase 8', 'Lahore', 31.4424, 74.4014, 'Area'],
  ['Johar Town', 'Lahore', 31.4697, 74.2728, 'Area'],
  ['Expo Center Lahore', 'Lahore', 31.4670, 74.2650, 'Landmark'],
  ['Wapda Town', 'Lahore', 31.4437, 74.2764, 'Area'],
  ['Valencia Town', 'Lahore', 31.4147, 74.2518, 'Area'],
  ['Iqbal Town', 'Lahore', 31.5095, 74.2840, 'Area'],
  ['Allama Iqbal Town', 'Lahore', 31.5095, 74.2840, 'Area'],
  ['Faisal Town', 'Lahore', 31.4865, 74.3005, 'Area'],
  ['Ferozepur Road', 'Lahore', 31.4930, 74.3280, 'Street'],
  ['Canal Road Lahore', 'Lahore', 31.4970, 74.3650, 'Street'],
  ['Jail Road Lahore', 'Lahore', 31.5410, 74.3470, 'Street'],
  ['Mall Road Lahore', 'Lahore', 31.5620, 74.3260, 'Street'],
  ['Raiwind Road', 'Lahore', 31.4010, 74.2480, 'Street'],
  ['Lahore Ring Road', 'Lahore', 31.4900, 74.2200, 'Street'],
  ['Liberty Market', 'Lahore', 31.5116, 74.3448, 'Landmark'],
  ['Anarkali Bazaar', 'Lahore', 31.5655, 74.3135, 'Landmark'],
  ['Ichhra', 'Lahore', 31.5290, 74.3220, 'Area'],
  ['Shadman', 'Lahore', 31.5470, 74.3340, 'Area'],
  ['Muslim Town', 'Lahore', 31.5100, 74.3310, 'Area'],
  ['Harbanspura', 'Lahore', 31.5830, 74.3950, 'Area'],
  ['LDA Avenue', 'Lahore', 31.4350, 74.2810, 'Area'],
  ['Bahria Town Lahore', 'Lahore', 31.3680, 74.1880, 'Area'],
  ['Gujranwala', 'Gujranwala', 32.1877, 74.1945, 'City'],
  ['Satellite Town', 'Gujranwala', 32.1710, 74.1900, 'Area'],
  ['Model Town', 'Gujranwala', 32.1770, 74.1900, 'Area'],
  ['GT Road', 'Gujranwala', 32.1900, 74.1800, 'Street'],
  ['Gujrat', 'Gujrat', 32.5731, 74.0780, 'City'],
  ['Model Town', 'Gujrat', 32.5750, 74.0800, 'Area'],
  ['Jalalpur Jattan Road', 'Gujrat', 32.5900, 74.0850, 'Street'],
  ['Islamabad', 'Islamabad Capital Territory', 33.6844, 73.0479, 'City'],
  ['Blue Area', 'Islamabad', 33.7077, 73.0500, 'Area'],
  ['F-6 Markaz', 'Islamabad', 33.7238, 73.0708, 'Area'],
  ['F-7 Markaz', 'Islamabad', 33.7215, 73.0565, 'Area'],
  ['F-8 Markaz', 'Islamabad', 33.7073, 73.0350, 'Area'],
  ['G-9 Markaz', 'Islamabad', 33.6881, 73.0410, 'Area'],
  ['G-10 Markaz', 'Islamabad', 33.6705, 73.0137, 'Area'],
  ['I-8 Markaz', 'Islamabad', 33.6676, 73.0762, 'Area'],
  ['Daman-e-Koh', 'Islamabad', 33.7380, 73.0550, 'Landmark'],
  ['Margalla Road', 'Islamabad', 33.7150, 73.0630, 'Street'],
  ['Kashmir Highway', 'Islamabad', 33.6660, 73.0930, 'Street'],
  ['Karachi', 'Karachi', 24.8607, 67.0011, 'City'],
  ['Clifton', 'Karachi', 24.8138, 67.0300, 'Area']
];

const ALIASES = new Map([
  ['gulberg', ['gulbur', 'gul barg']],
  ['thokar niaz baig', ['thokar niazi baig', 'thokar']],
  ['dha phase 5', ['defence phase 5', 'dha p5']],
  ['bahria town lahore', ['bahriya town']],
  ['rawalpindi', ['pindi']],
  ['islamabad', ['islambad']],
  ['lahore', ['lahor']],
  ['karachi', ['khi']],
  ['johar town', ['johar']],
  ['model town', ['modeltown']],
  ['shalimar hospital', ['shalamar hospital', 'shalimar hosp', 'inshallah hospital', 'inshallah']],
  ['children hospital lahore', ['children hospital', "children's hospital", 'childrens hospital', 'bachon ka hospital']],
  ['chowk yateem khana', ['chowk yateemkhan', 'yateem khana chowk', 'yatim khana chowk', 'yateem khana', 'yatim khana']]
]);

const CITY_ALIASES = new Map([
  ['islamabad capital territory', 'Islamabad'],
  ['islamabad', 'Islamabad'],
  ['karachi', 'Karachi'],
  ['lahore', 'Lahore'],
  ['sialkot', 'Sialkot'],
  ['gujranwala', 'Gujranwala'],
  ['gujrat', 'Gujrat'],
  ['rawalpindi', 'Rawalpindi']
]);

const CHAR_MAP = {
  ا: 'a', آ: 'a', أ: 'a', إ: 'i', ی: 'i', ي: 'i', ے: 'e',
  و: 'u', ؤ: 'u', ہ: 'h', ه: 'h', ھ: 'h', ک: 'k', ك: 'k',
  گ: 'g', ج: 'j', چ: 'ch', خ: 'kh', غ: 'gh', ق: 'q', ع: 'a',
  ب: 'b', پ: 'p', ت: 't', ٹ: 't', ث: 's', س: 's', ص: 's',
  د: 'd', ڈ: 'd', ذ: 'z', ز: 'z', ض: 'z', ظ: 'z',
  ر: 'r', ڑ: 'r', ف: 'f', ل: 'l', م: 'm', ن: 'n', ں: 'n',
  ش: 'sh', ژ: 'zh'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map(char => CHAR_MAP[char] || char)
    .join('')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return normalize(value).replace(/\s/g, '');
}

function phonetic(value) {
  const input = compact(value);
  if (!input) return '';
  const groups = { b: '1', p: '1', f: '1', v: '1', c: '2', k: '2', q: '2', g: '2', j: '2', x: '2', s: '2', z: '2', d: '3', t: '3', l: '4', m: '5', n: '5', r: '6' };
  let result = input[0];
  let previous = groups[input[0]] || '';
  for (const char of input.slice(1)) {
    const group = groups[char] || '';
    if (group && group !== previous) result += group;
    previous = group || previous;
    if (result.length >= 4) break;
  }
  return result.padEnd(4, '0');
}

function levenshtein(left, right, limit = Infinity) {
  const a = String(left || '');
  const b = String(right || '');
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    let rowMinimum = current[0];
    for (let j = 0; j < b.length; j++) {
      current.push(Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + (a[i] === b[j] ? 0 : 1)
      ));
      rowMinimum = Math.min(rowMinimum, current[current.length - 1]);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function cityMatches(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function haversine(aLat, aLng, bLat, bLng) {
  const radius = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const first = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(first), Math.sqrt(1 - first));
}

function makeRecord([primary, city, lat, lon, kind]) {
  const aliasValues = [];
  for (const [canonical, aliases] of ALIASES) {
    if (normalize(primary) === canonical || canonical.includes(normalize(primary))) aliasValues.push(...aliases);
  }
  const values = [primary, city, ...aliasValues].map(normalize).filter(Boolean);
  return {
    primary, city, lat, lon, kind,
    values,
    tokens: [...new Set(values.flatMap(value => value.split(' ')))],
    prefixes: [...new Set(values.flatMap(value => {
      const result = [];
      for (const token of value.split(' ')) {
        for (let i = 1; i <= token.length; i++) result.push(token.slice(0, i));
      }
      return result;
    }))],
    phonetics: [...new Set(values.map(phonetic))]
  };
}

const records = LOCAL_LOCATIONS.map(makeRecord);
const prefixIndex = new Map();
const tokenIndex = new Map();
const phoneticIndex = new Map();
for (const [id, record] of records.entries()) {
  for (const key of record.prefixes) prefixIndex.set(key, [...(prefixIndex.get(key) || []), id]);
  for (const key of record.tokens) tokenIndex.set(key, [...(tokenIndex.get(key) || []), id]);
  for (const key of record.phonetics) phoneticIndex.set(key, [...(phoneticIndex.get(key) || []), id]);
}

function scoreRecord(record, query) {
  const queryTokens = normalize(query).split(' ').filter(Boolean);
  if (!queryTokens.length) return 99;
  let score = 0;
  for (const queryToken of queryTokens) {
    let best = 99;
    for (const value of record.values) {
      for (const valueToken of value.split(' ')) {
        if (valueToken === queryToken) best = Math.min(best, 0);
        else if (valueToken.startsWith(queryToken)) best = Math.min(best, 1);
        else if (valueToken.includes(queryToken)) best = Math.min(best, 2);
        const maxDistance = queryToken.length < 5 ? 1 : queryToken.length < 8 ? 2 : 3;
        if (queryToken.length >= 3 && levenshtein(valueToken, queryToken, maxDistance) <= maxDistance) {
          best = Math.min(best, 3);
        }
        const phoneticLimit = Math.min(3, Math.max(2, Math.ceil(queryToken.length * .5)));
        if (queryToken.length >= 4
          && levenshtein(valueToken, queryToken, phoneticLimit) <= phoneticLimit
          && phonetic(valueToken) === phonetic(queryToken)) {
          best = Math.min(best, 3);
        }
      }
    }
    if (best === 99) return 99;
    score = Math.max(score, best);
  }
  return score;
}

function searchLocations(query, { city = '', lat, lng, broad = false, limit = 24 } = {}) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const candidateIds = new Set();
  for (const queryToken of queryTokens) {
    for (const id of prefixIndex.get(queryToken) || []) candidateIds.add(id);
    for (const id of tokenIndex.get(queryToken) || []) candidateIds.add(id);
    for (const id of phoneticIndex.get(phonetic(queryToken)) || []) candidateIds.add(id);
  }
  // If a typo has no indexed key, the bounded corpus scan is still tiny and
  // keeps the index tolerant without turning every request into provider I/O.
  if (!candidateIds.size) records.forEach((_record, id) => candidateIds.add(id));
  const preferredCity = CITY_ALIASES.get(normalize(city)) || city;
  const center = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? { lat: Number(lat), lng: Number(lng) }
    : null;
  return [...candidateIds]
    .map(id => {
      const record = records[id];
      const relevance = scoreRecord(record, normalizedQuery);
      const distance = center ? haversine(center.lat, center.lng, record.lat, record.lon) : Infinity;
      return {
        id,
        primary: record.primary,
        secondary: record.city,
        city: record.city,
        lat: record.lat,
        lon: record.lon,
        kind: record.kind,
        display_name: `${record.primary}, ${record.city}, Pakistan`,
        address: `${record.primary}, ${record.city}, Pakistan`,
        local: true,
        relevance,
        cityPriority: preferredCity && cityMatches(record.city, preferredCity) ? 0 : 1,
        distance
      };
    })
    .filter(record => record.relevance < 5)
    .filter(record => broad || !preferredCity || cityMatches(record.city, preferredCity))
    .sort((a, b) =>
      a.cityPriority - b.cityPriority
      || a.relevance - b.relevance
      || a.distance - b.distance
      || a.primary.localeCompare(b.primary)
    )
    .slice(0, limit)
    .map(({ id, relevance, cityPriority, distance, ...record }) => record);
}

module.exports = {
  LOCAL_LOCATIONS,
  normalize,
  searchLocations
};