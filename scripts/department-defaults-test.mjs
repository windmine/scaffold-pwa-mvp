import assert from 'node:assert/strict';

// The helpers are pure; the shell's element registry needs no real DOM here.
globalThis.document = { getElementById: () => null };
const {
  DEFAULT_BRAND_LOGO,
  DEPARTMENT_LOGOS,
  mutualDepartmentId,
  defaultStaffDepartmentId
} = await import('../assets/js/app-shell-state.js');
delete globalThis.document;

assert.equal(DEFAULT_BRAND_LOGO.src, '/assets/icons/reportflow-icon.svg');
assert.equal(DEFAULT_BRAND_LOGO.alt, 'ReportFlow');
assert.equal(DEPARTMENT_LOGOS.leader.src, '/assets/icons/leader-logo-export.png');
assert.equal(DEPARTMENT_LOGOS.leader.alt, 'Leader Scaffolding');
assert.equal(DEPARTMENT_LOGOS.mutual.src, '/assets/icons/mutual-logo.svg');
assert.equal(DEPARTMENT_LOGOS.mutual.alt, 'Mutual');
assert.notEqual(DEPARTMENT_LOGOS.mutual, DEFAULT_BRAND_LOGO);
console.log('ok - default branding is ReportFlow while explicit company logos remain separate');

const departments = Object.freeze([
  Object.freeze({ id: 41, name: 'Leader' }),
  Object.freeze({ id: 77, name: '  mUtUaL  ' }),
  Object.freeze({ id: 93, name: 'MC' })
]);
assert.equal(mutualDepartmentId(departments), '77');
assert.equal(mutualDepartmentId([{ id: '108', name: 'Mutual' }]), '108');
assert.equal(mutualDepartmentId([{ id: 77, name: 'Other' }]), '');
assert.equal(mutualDepartmentId([{ id: 0, name: 'Mutual' }]), '');
assert.equal(mutualDepartmentId([]), '');
assert.equal(mutualDepartmentId(null), '');
console.log('ok - Mutual resolves by available name, with no seeded-ID or registration fallback');

const globalAdmin = Object.freeze({ isGlobalAdmin: true, departmentId: 41, dashboardDepartmentId: null });
assert.equal(defaultStaffDepartmentId(globalAdmin, departments, ''), '77');
assert.equal(defaultStaffDepartmentId(globalAdmin, departments, null), '77');
assert.equal(defaultStaffDepartmentId(globalAdmin, departments, '93'), '93');
assert.equal(defaultStaffDepartmentId(globalAdmin, departments, '41'), '41');
assert.equal(defaultStaffDepartmentId(globalAdmin, departments, '999'), '');
assert.equal(defaultStaffDepartmentId(globalAdmin, [departments[0], departments[2]], ''), '41');
assert.equal(defaultStaffDepartmentId(globalAdmin, [departments[2]], ''), '93');
assert.equal(defaultStaffDepartmentId(globalAdmin, [], ''), '');
assert.equal(globalAdmin.departmentId, 41);
assert.equal(globalAdmin.dashboardDepartmentId, null);
console.log('ok - new Staff defaults respect explicit focus, Mutual, then available fallback without changing All');

const departmentSupervisor = Object.freeze({ isGlobalAdmin: false, departmentId: 41 });
assert.equal(defaultStaffDepartmentId(departmentSupervisor, departments, '77'), '41');
assert.equal(defaultStaffDepartmentId(departmentSupervisor, [], ''), '41');
assert.equal(defaultStaffDepartmentId(null, departments, ''), '');
console.log('ok - non-global staff creation stays in the existing user department');
