export const DEMO_DESCRIPTION = 'DEMO: Fictional presentation data only. Not an operational record, safety assessment or certification.';

export const WORKERS = Object.freeze([
  Object.freeze({ key: 'alex', name: 'Alex Example (DEMO)' }),
  Object.freeze({ key: 'jamie', name: 'Jamie Sample (DEMO)' }),
  Object.freeze({ key: 'taylor', name: 'Taylor Practice (DEMO)' })
]);

const DEMO_SIGNATURE = '__DEMO_SIGNATURE__';

function field(id, label, type, extra = {}) {
  return { id, label, type, ...extra };
}

function reportDate(anchorDateISO, offset) {
  const date = new Date(`${anchorDateISO}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function attendee(key) {
  return {
    attendee_name: WORKERS.find((worker) => worker.key === key).name,
    attendee_signature: DEMO_SIGNATURE
  };
}

export function presentationDataset(runId, anchorDateISO) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(runId)) {
    throw new Error('Demo run ID must contain 1-48 letters, numbers, underscores or hyphens.');
  }
  const parsedAnchor = new Date(`${anchorDateISO}T12:00:00.000Z`);
  if (typeof anchorDateISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDateISO)
      || Number.isNaN(parsedAnchor.valueOf()) || parsedAnchor.toISOString().slice(0, 10) !== anchorDateISO) {
    throw new Error('Demo anchor date must be a valid YYYY-MM-DD calendar date.');
  }

  const templates = [
    {
      key: 'toolbox', name: `DEMO - Toolbox Talk - ${runId}`, description: DEMO_DESCRIPTION,
      fields: [
        field('meeting', 'Meeting details', 'section'),
        field('topic', 'Discussion topic', 'text', { required: true }),
        field('facilitator', 'Facilitator', 'text', { required: true }),
        field('meeting_time', 'Meeting time', 'text'),
        field('previous', 'Previous meeting', 'section'),
        field('previous_actions', 'Previous actions', 'textarea'),
        field('discussion', 'New meeting', 'section'),
        field('discussion_notes', 'Discussion notes', 'textarea', { required: true }),
        field('next_action', 'Next action', 'textarea'),
        field('due_date', 'Target date', 'date'),
        field('signoff', 'Sign off', 'section'),
        field('attendees', 'Attendees', 'repeat', { min_rows: 1, max_rows: 3 }),
        field('attendee_name', 'Name', 'text', { required: true, repeat: 'attendees' }),
        field('attendee_signature', 'Demo signature', 'signature', { repeat: 'attendees' })
      ]
    },
    {
      key: 'observation', name: `DEMO - Site Observation - ${runId}`, description: DEMO_DESCRIPTION,
      fields: [
        field('details', 'Observation details', 'section'),
        field('reference', 'Reference', 'text', { required: true }),
        field('area', 'Area', 'text', { required: true }),
        field('category', 'Category', 'select', { required: true, options: ['Housekeeping', 'Access', 'Materials'] }),
        field('observation', 'Observation', 'textarea', { required: true }),
        field('suggested_action', 'Suggested action', 'textarea'),
        field('follow_up', 'Follow-up requested', 'checkbox'),
        field('reporter_signature', 'Demo signature', 'signature')
      ]
    },
    {
      key: 'progress', name: `DEMO - Daily Progress - ${runId}`, description: DEMO_DESCRIPTION,
      fields: [
        field('summary', 'Work summary', 'section'),
        field('reference', 'Reference', 'text', { required: true }),
        field('work_area', 'Work area', 'text'),
        field('progress', 'Progress', 'select', { required: true, options: ['Planned', 'In progress', 'Complete for demonstration'] }),
        field('completed', 'Activities described', 'textarea', { required: true }),
        field('next_steps', 'Next steps', 'textarea'),
        field('materials', 'Material quantities', 'repeat', { min_rows: 0, max_rows: 5 }),
        field('material_name', 'Item', 'text', { required: true, repeat: 'materials' }),
        field('material_quantity', 'Quantity', 'number', { required: true, repeat: 'materials' }),
        field('reporter_signature', 'Demo signature', 'signature')
      ]
    }
  ];

  // Intentionally synthetic coordinates, not real client premises or attendance locations.
  const sites = [
    { key: 'harbour', name: `DEMO - Harbour Yard - ${runId}`, address: 'Fictional presentation location; not a real work site.', latitude: 0, longitude: 0, allowed_radius_m: 100 },
    { key: 'riverside', name: `DEMO - Riverside Workshop - ${runId}`, address: 'Fictional presentation location; not a real work site.', latitude: 0, longitude: 0.001, allowed_radius_m: 100 }
  ];

  const reports = [
    {
      key: 'T01', templateKey: 'toolbox', workerKey: 'alex', siteKey: 'harbour', workDate: reportDate(anchorDateISO, -2), workflow: 'resolved', includePhoto: true,
      answers: {
        topic: 'DEMO-T01 walkway briefing', facilitator: 'Alex Example (DEMO)', meeting_time: '08:00',
        previous_actions: 'DEMO: Prepared a tabletop presentation model and a set of sample storage labels.',
        discussion_notes: 'DEMO: Discussed the walkway drawn on the presentation model and where the sample storage labels should be placed. This is a fictional briefing, not a site assessment.',
        next_action: 'DEMO: Add the example storage labels to the model before the next presentation.',
        due_date: reportDate(anchorDateISO, -1), attendees: [attendee('alex'), attendee('jamie'), attendee('taylor')]
      },
      finalNote: 'DEMO review complete. Example storage labels added to the presentation model.'
    },
    {
      key: 'T02', templateKey: 'toolbox', workerKey: 'jamie', siteKey: 'riverside', workDate: reportDate(anchorDateISO, -1), workflow: 'in_review', includePhoto: false,
      answers: {
        topic: 'DEMO-T02 delivery coordination', facilitator: 'Jamie Sample (DEMO)', meeting_time: '08:15',
        previous_actions: 'DEMO: Reviewed the sample label cards from the previous fictional meeting.',
        discussion_notes: 'DEMO: Walked through a fictional loading sequence using display blocks. The group discussed how delivery notes could be captured in a Report.',
        next_action: 'DEMO: Review the presentation schedule with the demo team.',
        due_date: anchorDateISO, attendees: [attendee('jamie'), attendee('alex')]
      },
      finalNote: null
    },
    {
      key: 'T03', templateKey: 'toolbox', workerKey: 'taylor', siteKey: 'harbour', workDate: anchorDateISO, workflow: 'submitted', includePhoto: true,
      answers: {
        topic: 'DEMO-T03 weather discussion', facilitator: 'Taylor Practice (DEMO)', meeting_time: '08:30',
        previous_actions: 'DEMO: Prepared an alternate sequence of presentation slides.',
        discussion_notes: 'DEMO: Discussed how a team might record a change in plans if weather affected work. No actual forecast, work instruction or safety determination is recorded here.',
        next_action: 'DEMO: Show the alternate sequence during the presentation.',
        due_date: reportDate(anchorDateISO, 1), attendees: [attendee('taylor')]
      },
      finalNote: null
    },
    {
      key: 'O01', templateKey: 'observation', workerKey: 'jamie', siteKey: 'riverside', workDate: reportDate(anchorDateISO, -2), workflow: 'resolved', includePhoto: true,
      answers: {
        reference: `DEMO-O01 labels ${runId}`, area: 'DEMO storage bay model', category: 'Materials',
        observation: 'DEMO: Two presentation containers had unclear labels in the fictional storage bay model.',
        suggested_action: 'DEMO: Replace the sample labels with larger cards for presentation readability.',
        follow_up: true, reporter_signature: DEMO_SIGNATURE
      },
      finalNote: 'DEMO labels updated; fictional observation closed for presentation.'
    },
    {
      key: 'O02', templateKey: 'observation', workerKey: 'taylor', siteKey: 'harbour', workDate: reportDate(anchorDateISO, -1), workflow: 'in_review', includePhoto: true,
      answers: {
        reference: `DEMO-O02 cable ${runId}`, area: 'DEMO entrance diagram', category: 'Access',
        observation: 'DEMO: A simulated loose cable is shown in the presentation diagram. This is an illustration, not a report of an actual hazard.',
        suggested_action: 'DEMO: Discuss an alternative illustrated route during the demonstration.',
        follow_up: true, reporter_signature: DEMO_SIGNATURE
      },
      finalNote: null
    },
    {
      key: 'O03', templateKey: 'observation', workerKey: 'alex', siteKey: null, workDate: anchorDateISO, workflow: 'submitted', includePhoto: false,
      answers: {
        reference: `DEMO-O03 packaging ${runId}`, area: 'DEMO training room model', category: 'Housekeeping',
        observation: 'DEMO: Sample packaging has been placed beside the model workstation to illustrate a photo-free Report with no Site selected.',
        suggested_action: 'DEMO: Move the display packaging to the labelled presentation tray.',
        follow_up: false, reporter_signature: DEMO_SIGNATURE
      },
      finalNote: null
    },
    {
      key: 'P01', templateKey: 'progress', workerKey: 'taylor', siteKey: 'harbour', workDate: reportDate(anchorDateISO, -2), workflow: 'resolved', includePhoto: true,
      answers: {
        reference: `DEMO-P01 northbay ${runId}`, work_area: 'DEMO northbay model', progress: 'Complete for demonstration',
        completed: 'DEMO: Arranged the tabletop presentation model and added sample labels. No real construction completion or certification is claimed.',
        next_steps: 'DEMO: Use the example photos and quantities to demonstrate the PDF export.',
        materials: [{ material_name: 'DEMO display blocks', material_quantity: 6 }, { material_name: 'DEMO label cards', material_quantity: 4 }],
        reporter_signature: DEMO_SIGNATURE
      },
      finalNote: 'DEMO summary reviewed; example photos and quantities recorded.'
    },
    {
      key: 'P02', templateKey: 'progress', workerKey: 'alex', siteKey: 'riverside', workDate: reportDate(anchorDateISO, -1), workflow: 'in_review', includePhoto: true,
      answers: {
        reference: `DEMO-P02 inventory ${runId}`, work_area: 'DEMO inventory display', progress: 'In progress',
        completed: 'DEMO: Counted the sample inventory for the presentation and entered it as repeated material rows.',
        next_steps: 'DEMO: Check that both rows appear clearly in the exported PDF.',
        materials: [{ material_name: 'DEMO display blocks', material_quantity: 12 }, { material_name: 'DEMO label cards', material_quantity: 8 }],
        reporter_signature: DEMO_SIGNATURE
      },
      finalNote: null
    },
    {
      key: 'P03', templateKey: 'progress', workerKey: 'jamie', siteKey: null, workDate: anchorDateISO, workflow: 'submitted', includePhoto: false,
      answers: {
        reference: `DEMO-P03 handover ${runId}`, work_area: 'DEMO preparation desk', progress: 'Planned',
        completed: 'DEMO: Prepared a fictional handover outline to demonstrate an open Report without an assigned Site.',
        next_steps: 'DEMO: Add a demonstration illustration and review notes during the presentation.',
        materials: [], reporter_signature: DEMO_SIGNATURE
      },
      finalNote: null
    }
  ];

  return { templates, sites, reports };
}
