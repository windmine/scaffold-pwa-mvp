import assert from 'node:assert/strict';
import { createTemplateDraftStore, saveTemplateDraft, templateDraftKey } from '../assets/js/report-template-drafts.js';

const supervisor = { id: 12, role: 'supervisor', departmentId: 3, isGlobalAdmin: false };
const draft = {
  id: 'draft-1', kind: 'report-template-editor', schemaVersion: 1,
  ownerId: '12', ownerDepartmentId: '3', departmentId: '3', purpose: 'report',
  formId: null, baseVersion: null, name: '  Unfinished ', description: '',
  builder: { fields: [], rawText: 'incomplete | raw |', rawDirty: true },
  savedAt: '2026-09-15T03:25:00.000Z'
};

// A serialized storage boundary models independent tabs sharing one database.
function memoryStorage(initialRows = []) {
  const rows = new Map(initialRows.map((row, index) => [row?.key ?? index, structuredClone(row)]));
  let pending = Promise.resolve();
  return {
    async listRows() {
      await pending;
      return structuredClone([...rows.values()]);
    },
    updateRow(key, update) {
      const operation = pending.then(() => {
        const next = update(structuredClone(rows.get(key)));
        rows.set(key, structuredClone(next));
        return structuredClone(next);
      });
      pending = operation.catch(() => {});
      return operation;
    }
  };
}

{
  const store = createTemplateDraftStore(memoryStorage());
  const saved = await store.saveTemplateDraft(draft, supervisor);
  assert.deepEqual(saved, { ...draft, storeRevision: 1 });
  assert.deepEqual(await store.listTemplateDrafts(supervisor, 3), [saved]);
  assert.equal(draft.storeRevision, undefined);
  console.log('ok - unfinished Report Template input round-trips without validation or mutation');
}

{
  const store = createTemplateDraftStore(memoryStorage());
  const foreignDraft = { ...draft, departmentId: '4' };
  for (const user of [null, { ...supervisor, role: 'worker' }, { ...supervisor, id: 99 },
    { ...supervisor, departmentId: 4 }, { ...supervisor, id: [12] },
    { ...supervisor, departmentId: [3] }]) {
    await assert.rejects(store.saveTemplateDraft(draft, user));
    assert.deepEqual(await store.listTemplateDrafts(user), []);
    await assert.rejects(store.removeTemplateDraft(draft, user));
  }
  await assert.rejects(store.saveTemplateDraft(foreignDraft, { ...supervisor, isGlobalAdmin: 'false' }));
  const globalAdmin = { ...supervisor, isGlobalAdmin: true };
  const saved = await store.saveTemplateDraft(foreignDraft, globalAdmin);
  assert.deepEqual(await store.listTemplateDrafts(globalAdmin, '4'), [saved]);
  assert.deepEqual(await store.listTemplateDrafts(globalAdmin, '3'), []);
  assert.deepEqual(await store.listTemplateDrafts(supervisor), []);
  assert.deepEqual(await store.listTemplateDrafts({ ...globalAdmin, departmentId: 4 }), []);
  console.log('ok - exact Supervisor/home Department scope and explicit global-admin authority isolate drafts');
}

{
  const storage = memoryStorage();
  const firstTab = createTemplateDraftStore(storage);
  const secondTab = createTemplateDraftStore(storage);
  const conflict = { code: 'TEMPLATE_DRAFT_CONFLICT' };
  const first = await firstTab.saveTemplateDraft(draft, supervisor);
  await assert.rejects(secondTab.saveTemplateDraft(draft, supervisor), conflict);
  const competing = await Promise.allSettled([
    firstTab.saveTemplateDraft({ ...first, name: 'First tab update' }, supervisor),
    secondTab.saveTemplateDraft({ ...first, name: 'Second tab update' }, supervisor)
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find((result) => result.status === 'rejected').reason.code, conflict.code);
  const winner = competing.find((result) => result.status === 'fulfilled').value;
  assert.equal(winner.storeRevision, 2);
  await assert.rejects(secondTab.removeTemplateDraft(first, supervisor), conflict);
  assert.deepEqual(await firstTab.listTemplateDrafts(supervisor), [winner]);
  await firstTab.removeTemplateDraft(winner, supervisor);
  assert.deepEqual(await secondTab.listTemplateDrafts(supervisor), []);
  await assert.rejects(secondTab.saveTemplateDraft(winner, supervisor), conflict);
  await assert.rejects(secondTab.saveTemplateDraft(draft, supervisor), conflict);
  const newEditor = { ...draft, id: 'draft-2' };
  await firstTab.removeTemplateDraft(newEditor, supervisor);
  await assert.rejects(secondTab.saveTemplateDraft(newEditor, supervisor), conflict);
  console.log('ok - concurrent saves/removes reject stale revisions and permanent tombstones prevent resurrection');
}

{
  const invalidDrafts = [null, [], 'draft', 17,
    { ...draft, kind: 'work-form' }, { ...draft, schemaVersion: '1' }, { ...draft, schemaVersion: 2 },
    { ...draft, purpose: 'daywork' }, { ...draft, purpose: undefined },
    { ...draft, template_purpose: 'daywork' }, { ...draft, department_id: 4 },
    { ...draft, ownerId: 12 }, { ...draft, ownerDepartmentId: '03' },
    { ...draft, departmentId: 3 }, { ...draft, departmentId: ['3'] },
    { ...draft, id: '' }, { ...draft, id: 'other:key' },
    { ...draft, formId: 5, baseVersion: 1 }, { ...draft, formId: '5', baseVersion: null },
    { ...draft, formId: '5', baseVersion: 0 }, { ...draft, formId: '5', baseVersion: '1' },
    { ...draft, baseVersion: 1 }, { ...draft, baseVersion: undefined },
    { ...draft, name: null }, { ...draft, description: {} }, { ...draft, builder: null },
    { ...draft, builder: { ...draft.builder, fields: [null] } },
    { ...draft, builder: { ...draft.builder, fields: ['field'] } },
    { ...draft, builder: { ...draft.builder, rawText: {} } },
    { ...draft, builder: { ...draft.builder, rawDirty: 'false' } },
    { ...draft, savedAt: 2026 }, { ...draft, savedAt: 'not-a-date' },
    { ...draft, savedAt: '2026-09-15' }, { ...draft, savedAt: '2026-02-30T00:00:00.000Z' },
    { ...draft, storeRevision: null }, { ...draft, storeRevision: -1 },
    { ...draft, storeRevision: '1' }, { ...draft, publicationState: 'published' }
  ];
  const validRow = { key: templateDraftKey(draft), value: draft, updatedAt: draft.savedAt };
  const malformedRows = [null, [], 'row', { key: 17, value: draft },
    { ...validRow, key: 'work-form-draft:12:5' },
    { ...validRow, key: `${validRow.key}-wrong` },
    { ...validRow, deleted: true },
    { ...validRow, storeRevision: 7 },
    { ...validRow, value: { ...draft, storeRevision: 7 } },
    ...invalidDrafts.map((value, index) => ({ key: `${validRow.key}-invalid-${index}`, value }))
  ];
  const reader = createTemplateDraftStore({ listRows: async () => [...malformedRows, validRow] });
  assert.deepEqual(await reader.listTemplateDrafts(supervisor), [draft]);
  const store = createTemplateDraftStore(memoryStorage());
  for (const invalid of invalidDrafts) {
    await assert.rejects(store.saveTemplateDraft(invalid, supervisor));
    await assert.rejects(store.removeTemplateDraft(invalid, supervisor));
  }
  const uncertain = { ...draft, id: 'uncertain-edit', formId: '5', baseVersion: 2, publicationState: 'uncertain' };
  const saved = await store.saveTemplateDraft(uncertain, supervisor);
  assert.equal(saved.publicationState, 'uncertain');
  assert.deepEqual((await store.listTemplateDrafts(supervisor)).find((item) => item.id === uncertain.id), saved);
  assert.deepEqual(await store.listTemplateDrafts(supervisor, ['3']), []);
  console.log('ok - malformed rows, schema/purpose conflicts and invalid revisions are rejected without hiding valid drafts');
}

{
  const storage = memoryStorage();
  const store = createTemplateDraftStore(storage);
  const saved = await store.saveTemplateDraft({ ...draft, formId: '5', baseVersion: 2 }, supervisor);
  await assert.rejects(store.saveTemplateDraft({ ...saved, baseVersion: 3 }, supervisor), {
    code: 'TEMPLATE_DRAFT_CONFLICT'
  });
  const uncertain = await store.saveTemplateDraft({ ...saved, publicationState: 'uncertain' }, supervisor);
  await assert.rejects(store.saveTemplateDraft(saved, supervisor), {
    code: 'TEMPLATE_DRAFT_CONFLICT', conflictReason: 'changed', publicationState: 'uncertain'
  });
  await store.removeTemplateDraft({ ...uncertain, publicationState: undefined }, supervisor);
  const reopened = createTemplateDraftStore(storage);
  await assert.rejects(reopened.saveTemplateDraft(saved, supervisor), {
    code: 'TEMPLATE_DRAFT_CONFLICT', conflictReason: 'removed', publicationState: 'uncertain'
  });
  assert.deepEqual(await reopened.listTemplateDrafts(supervisor), []);
  console.log('ok - conflicts retain publication uncertainty and an existing draft cannot silently change its baseline');
}

{
  const storage = memoryStorage();
  const unavailable = new Error('Storage quota reached');
  let failing = true;
  const store = createTemplateDraftStore({
    listRows: storage.listRows,
    updateRow: (...args) => failing ? Promise.reject(unavailable) : storage.updateRow(...args)
  });
  await assert.rejects(store.saveTemplateDraft(draft, supervisor), (error) => error === unavailable);
  assert.deepEqual(await store.listTemplateDrafts(supervisor), []);
  failing = false;
  const saved = await store.saveTemplateDraft(draft, supervisor);
  failing = true;
  await assert.rejects(store.removeTemplateDraft(saved, supervisor), (error) => error === unavailable);
  assert.deepEqual(await store.listTemplateDrafts(supervisor), [saved]);
  const reader = createTemplateDraftStore({ listRows: async () => { throw unavailable; } });
  await assert.rejects(reader.listTemplateDrafts(supervisor), (error) => error === unavailable);
  const malformedReader = createTemplateDraftStore({ listRows: async () => null });
  await assert.rejects(malformedReader.listTemplateDrafts(supervisor), /invalid result/);
  console.log('ok - save/remove/read failures remain explicit and leave retryable input or stored drafts intact');
}

{
  const store = createTemplateDraftStore(memoryStorage());
  const input = structuredClone(draft);
  const owner = { ...supervisor };
  const saving = store.saveTemplateDraft(input, owner);
  input.name = 'Changed after autosave started';
  input.id = 'different-editor';
  input.builder.rawText = 'Do not replace the earlier capture';
  owner.id = 99;
  owner.departmentId = 4;
  const saved = await saving;
  assert.deepEqual(saved, { ...draft, storeRevision: 1 });
  saved.builder.rawText = 'Do not mutate storage through the returned object';
  const [restored] = await store.listTemplateDrafts(supervisor);
  assert.equal(restored.builder.rawText, draft.builder.rawText);
  restored.name = 'Do not mutate storage through a listed object';
  assert.equal((await store.listTemplateDrafts(supervisor))[0].name, draft.name);
  assert.deepEqual(await store.listTemplateDrafts(owner), []);
  console.log('ok - asynchronous saves snapshot caller ownership/content and returned drafts never alias storage');
}

{
  // Exercise the production adapter at the browser boundary: request success is
  // not transaction commit, and request errors can bubble before tx.error exists.
  const originalIndexedDB = globalThis.indexedDB;
  const staged = Promise.withResolvers();
  const commit = Promise.withResolvers();
  const unavailable = new Error('IndexedDB request failed');
  let failurePhase = '';
  globalThis.indexedDB = {
    open() {
      const opening = {};
      queueMicrotask(() => {
        opening.result = {
          close() {},
          transaction() {
            const tx = { error: null };
            const fail = (request) => {
              request.error = unavailable;
              request.onerror?.({ target: request });
              tx.onerror?.({ target: request });
              tx.error = unavailable;
              tx.onabort?.();
            };
            tx.abort = () => queueMicrotask(() => tx.onabort?.());
            tx.objectStore = () => ({
              get() {
                const request = { result: undefined };
                queueMicrotask(() => failurePhase === 'read' ? fail(request) : request.onsuccess?.());
                return request;
              },
              put() {
                const request = {};
                if (failurePhase === 'write') queueMicrotask(() => fail(request));
                else {
                  staged.resolve();
                  void commit.promise.then(() => tx.oncomplete?.());
                }
                return request;
              }
            });
            return tx;
          }
        };
        opening.onsuccess();
      });
      return opening;
    }
  };
  try {
    let settled = false;
    const saving = saveTemplateDraft(draft, supervisor).then((saved) => { settled = true; return saved; });
    await staged.promise;
    assert.equal(settled, false);
    commit.resolve();
    assert.equal((await saving).storeRevision, 1);
    for (const phase of ['read', 'write']) {
      failurePhase = phase;
      await assert.rejects(saveTemplateDraft(draft, supervisor), (error) => error === unavailable);
    }
  } finally {
    if (originalIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDB;
  }
  console.log('ok - production IndexedDB adapter waits for commit and preserves read/write failure details');
}
