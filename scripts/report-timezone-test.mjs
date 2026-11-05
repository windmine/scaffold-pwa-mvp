import assert from 'node:assert/strict';
import { formatDateTime, formatPhotoTakenLabel, photoMetadataFromFile, photoTakenLabel } from '../assets/js/utils.js';
import { locationText } from '../assets/js/work-form-evidence-fields.js';

// Real IANA transitions, including the repeated autumn hour; never add a fixed offset.
const cases = [
  ['2026-11-04T23:35:07.766075Z', '5 Nov 2026, 12:35 pm NZDT'],
  ['2026-06-04T23:35:00Z', '5 Jun 2026, 11:35 am NZST'],
  ['2026-09-26T13:59:59Z', '27 Sept 2026, 1:59 am NZST'],
  ['2026-09-26T14:00:00Z', '27 Sept 2026, 3:00 am NZDT'],
  ['2026-04-04T13:59:59Z', '5 Apr 2026, 2:59 am NZDT'],
  ['2026-04-04T14:00:00Z', '5 Apr 2026, 2:00 am NZST'],
  ['2026-11-05T12:35:07.766075+13:00', '5 Nov 2026, 12:35 pm NZDT'],
];
for (const deviceZone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
  process.env.TZ = deviceZone;
  for (const [instant, expected] of cases) {
    const date = new Date(instant), milliseconds = date.getTime();
    assert.equal(formatDateTime(instant).replace(/\s+/g, ' '), expected, deviceZone);
    assert.equal(formatDateTime(date).replace(/\s+/g, ' '), expected);
    assert.equal(date.getTime(), milliseconds, 'Formatting never adjusts the stored instant');
    const metadata = photoMetadataFromFile({ name: 'Synthetic.png', lastModified: milliseconds });
    assert.equal(metadata.taken_at, date.toISOString());
    assert.equal(formatPhotoTakenLabel({ lastModified: milliseconds }), formatDateTime(date));
    assert.equal(photoTakenLabel({ ...metadata, takenAtLabel: 'stale device-local label' }), formatDateTime(date));
    const location = Object.freeze({ latitude: -41, longitude: 174, accuracy: 10, captured_at: instant });
    assert.ok(locationText(location).includes(formatDateTime(date)));
    assert.equal(location.captured_at, instant);
  }
}
assert.equal(formatDateTime(null), '-');
assert.equal(formatDateTime('invalid'), '-');
assert.equal(photoTakenLabel({ takenAtLabel: 'Legacy label without original timestamp' }), 'Legacy label without original timestamp');
assert.equal(photoTakenLabel(null), '');
console.log('ok - New Zealand submission, draft, photo and location display: summer/winter, both DST boundaries and three device zones; original timestamps unchanged');
