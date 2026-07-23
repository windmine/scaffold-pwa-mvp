const LANGUAGE_STORAGE_KEY = 'leader-language';
const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = new Set(['en', 'zh']);
const PROTECTED_COMPANY_NAMES = new Set([
  'Leader',
  'Leader Field',
  'Leader Field Operations',
  'Leader Scaffolding',
  'Mutual',
  'MC',
  'Stech',
  'BOP'
]);
const PROTECTED_TECHNICAL_TEXT = new Set([
  'text|Area|required|id=area',
  'Pass Fail N/A',
  'work_time * workers'
]);

const LANGUAGE_META = {
  en: {
    htmlLang: 'en-NZ',
    title: 'Leader Field Operations',
    toggleText: '中文',
    toggleLabel: 'Switch language to Chinese',
    toggleTitle: 'Switch language to Chinese'
  },
  zh: {
    htmlLang: 'zh-Hans',
    title: 'Leader 现场作业',
    toggleText: 'English',
    toggleLabel: '切换语言为英文',
    toggleTitle: '切换语言为英文'
  }
};

const ZH_TEXT = {
  'Overview': '概览',
  'Review': '审核',
  'Reports': '报表',
  'People & Sites': '人员与工地',
  'Audit': '审计',
  'Workspace': '工作区',
  'Workspaces': '工作区',
  'Admin workspace': '管理工作区',
  'Choose workspace': '选择工作区',
  'Supervisor workspaces': '主管工作区',
  'Close workspace navigation': '关闭工作区导航',
  'Live status and scope': '实时状态和范围',
  'Queues, maps and corrections': '队列、地图和更正',
  'Analytics and exports': '分析和导出',
  'Teams and job locations': '团队和工作地点',
  'Reusable field forms': '可重复使用的现场表单',
  'Changes and deleted records': '变更和已删除记录',
  'Performance and exports': '绩效和导出',
  'Review records and corrections': '审核记录和更正',
  'Reusable work forms': '可重复使用的工作表单',
  'Audit and recovery': '审计和恢复',
  'Start with department scope and live review totals, then move into the workspace for the job at hand.': '先查看部门范围和实时审核总数，然后进入当前任务所需的工作区。',
  'Track operational trends, investigate exceptions, and export records for the selected department.': '跟踪运营趋势、调查异常情况，并导出所选部门的记录。',
  'Validate field evidence, inspect attendance locations, and add approved corrections when records are missing.': '核实现场证据、检查考勤位置，并在记录缺失时添加已批准的更正。',
  'Manage staff access, employment status, site coordinates, and allowed attendance radiuses.': '管理员工权限、在职状态、工地坐标和允许的考勤半径。',
  'Build, preview, version, archive, and reactivate the forms used by field teams.': '创建、预览、版本化、归档并重新启用现场团队使用的表单。',
  'Trace recorded changes and restore recently deleted attendance or task logs.': '追踪已记录的变更，并恢复最近删除的考勤或任务记录。',
  'New form': '\u65b0\u8868\u5355',
  'Build a work form': '\u521b\u5efa\u5de5\u4f5c\u8868\u5355',
  'Create the questions workers will complete in the field. Advanced syntax remains available when needed.': '\u521b\u5efa\u73b0\u573a\u5458\u5de5\u9700\u8981\u586b\u5199\u7684\u95ee\u9898\u3002\u9700\u8981\u65f6\u4ecd\u53ef\u4f7f\u7528\u9ad8\u7ea7\u8bed\u6cd5\u3002',
  'Form fields': '\u8868\u5355\u5b57\u6bb5',
  'Add cards in the same order workers should complete them.': '\u6309\u5458\u5de5\u586b\u5199\u7684\u987a\u5e8f\u6dfb\u52a0\u5b57\u6bb5\u5361\u7247\u3002',
  'Add field': '\u6dfb\u52a0\u5b57\u6bb5',
  'No fields yet. Add the first field to begin.': '\u5c1a\u65e0\u5b57\u6bb5\u3002\u8bf7\u6dfb\u52a0\u7b2c\u4e00\u4e2a\u5b57\u6bb5\u3002',
  'Advanced: edit raw field syntax': '\u9ad8\u7ea7\uff1a\u7f16\u8f91\u539f\u59cb\u5b57\u6bb5\u8bed\u6cd5',
  'Raw field syntax': '\u539f\u59cb\u5b57\u6bb5\u8bed\u6cd5',
  'Apply syntax': '\u5e94\u7528\u8bed\u6cd5',
  'Discard raw changes': '\u653e\u5f03\u539f\u59cb\u8bed\u6cd5\u66f4\u6539',
  'Field type': '\u5b57\u6bb5\u7c7b\u578b',
  'Label': '\u6807\u7b7e',
  'Required': '\u5fc5\u586b',
  'Short answer': '\u77ed\u6587\u672c',
  'Long answer': '\u957f\u6587\u672c',
  'Number': '\u6570\u5b57',
  'Choice': '\u9009\u62e9\u9898',
  'Yes / No': '\u662f / \u5426',
  'Section heading': '\u5206\u8282\u6807\u9898',
  'Calculated value': '\u8ba1\u7b97\u503c',
  'Repeating group': '\u91cd\u590d\u7ec4',
  'Options': '\u9009\u9879',
  'Only show in some cases': '\u4ec5\u5728\u7279\u5b9a\u6761\u4ef6\u4e0b\u663e\u793a',
  'Earlier field': '\u524d\u9762\u7684\u5b57\u6bb5',
  'Rule': '\u6761\u4ef6',
  'Value': '\u503c',
  'Minimum rows': '\u6700\u5c11\u884c\u6570',
  'Maximum rows': '\u6700\u591a\u884c\u6570',
  'Fields inside this group': '\u6b64\u7ec4\u5185\u7684\u5b57\u6bb5',
  'These cards repeat together for each row.': '\u8fd9\u4e9b\u5361\u7247\u4f1a\u5728\u6bcf\u4e00\u884c\u4e2d\u4e00\u8d77\u91cd\u590d\u3002',
  'Add group field': '\u6dfb\u52a0\u7ec4\u5185\u5b57\u6bb5',
  'No group fields yet.': '\u5c1a\u65e0\u7ec4\u5185\u5b57\u6bb5\u3002',
  'Work form fields': '工作表单字段',
  'Use the raw pipe-delimited format only for definitions the cards do not cover. Apply changes before previewing or saving.': '仅在字段卡不支持定义时使用原始竖线分隔格式。预览或保存前请先应用更改。',
  'Time range': '时间段',
  'Choose a value': '请选择一个值',
  'Add an answer field before this card to create a condition.': '请先在此字段卡前添加一个答题字段，再创建显示条件。',
  'Add an answer field before this card before creating a condition.': '请先在此字段卡前添加一个答题字段，再创建显示条件。',
  '(one per line)': '（每行一个）',
  'Formula': '公式',
  'Use earlier field keys with +, −, ×, ÷ and parentheses.': '使用前面字段的键，并配合 +、−、×、÷ 和括号。',
  'Untitled field': '未命名字段',
  'New field': '新字段',
  'Drag to reorder': '拖动排序',
  'What should the worker enter?': '员工需要填写什么？',
  'Field key:': '字段键：',
  'Field keys can use lowercase letters, numbers, and underscores only.': '字段键只能使用小写字母、数字和下划线。',
  'Add a label for this field.': '请为此字段添加标签。',
  'Repeating groups cannot be nested.': '重复组不能嵌套。',
  'Pending raw changes were discarded because a field card was edited.': '由于编辑了字段卡，待处理的原始语法更改已被放弃。',
  'Pending raw syntax discarded.': '待处理的原始语法已放弃。',
  'Fields can only be moved within the same group.': '字段只能在同一组内移动。',
  'Changing this field type will remove its type-specific settings. Continue?': '更改字段类型将删除该类型的专用设置。是否继续？',
  'Apply or discard the pending raw syntax before previewing or saving.': '预览或保存前，请应用或放弃待处理的原始语法。',
  'Raw syntax applied to the field cards.': '原始语法已应用到字段卡。',
  'Raw syntax applied.': '原始语法已应用。',
  'Raw changes discarded.': '原始语法更改已放弃。',
  'Raw syntax changes discarded.': '原始语法更改已放弃。',
  'Raw changes are pending. Apply or discard them before saving.': '原始语法有待处理的更改。保存前请应用或放弃这些更改。',
  '(required)': '（必填）',
  'signature pad': '签名板',
  'Draw your signature inside the box. Keyboard: focus the signature pad, press Space or Enter to start, use the arrow keys to draw (hold Shift for larger moves), then press Space, Enter or Escape to stop.': '请在框内签名。键盘操作：聚焦签名板，按空格键或回车键开始，使用方向键绘制（按住 Shift 可加大移动距离），然后按空格键、回车键或 Escape 键停止。',
  'The signature pad is blank.': '签名板为空。',
  'Signature captured.': '签名已记录。',
  'Signature cleared. The signature pad is blank.': '签名已清除。签名板为空。',
  'Keyboard drawing started. Use the arrow keys to draw, then press Space, Enter or Escape to stop.': '已开始键盘绘制。请使用方向键绘制，然后按空格键、回车键或 Escape 键停止。',
  'Keyboard drawing stopped. Signature captured.': '键盘绘制已停止。签名已记录。',
  'Keyboard drawing stopped. The signature pad is still blank.': '键盘绘制已停止。签名板仍为空。',
  'Manage today\'s field records': '管理今日现场记录',
  'Add missed check in / check out': '补录签到 / 签退',
  'Add attendance': '添加考勤',
  'Add attendance for a worker': '为员工添加考勤',
  'Use this when a worker performed the work but forgot to check in or out. The entry is approved, audit-logged, and marked as manual with no GPS result.': '员工已工作但忘记签到或签退时，请使用此功能。该记录会立即通过审核、写入审计日志，并标记为没有 GPS 结果的手动记录。',
  'Example: Worker confirmed start time with site supervisor.': '示例：员工已向工地主管确认开始时间。',
  'Add attendance entry': '添加考勤记录',
  'Submit approved log': '提交已批准日志',
  'Self or others': '本人或他人',
  'Add a task log': '添加任务日志',
  'Submit a log for yourself or another accessible user. Admin-entered logs are approved immediately and audit-logged.': '为自己或其他有权限的用户提交日志。管理员录入的日志会立即通过审核并写入审计日志。',
  'Rubbish bin': '回收站',
  'Deleted attendance and task logs': '已删除的考勤和任务日志',
  'Records can be restored for 30 days. After that they are permanently deleted automatically.': '记录可在 30 天内恢复，之后将自动永久删除。',
  'Notifications': '通知',
  'All records': '全部记录',
  'All sites': '全部工地',
  'All statuses': '全部状态',
  'All workers': '全部员工',
  'Attendance locations': '考勤位置',
  'Autosaves on this device.': '自动保存在本设备上。',
  'Choose the department to review': '选择要审核的部门',
  'Connect recorded points': '连接已记录的点',
  'Current view': '当前视图',
  'Dashboard scope': '仪表板范围',
  'Date and time': '日期和时间',
  'Daywork': '日工',
  'Entry type': '记录类型',
  'Exception analytics': '异常分析',
  'Exceptions': '异常',
  'Export management CSV': '导出管理 CSV',
  'Export printable report': '导出可打印报告',
  'Inside site': '工地范围内',
  'JPEG, PNG, or WebP; maximum 5 MB each.': '支持 JPEG、PNG 或 WebP；每张最大 5 MB。',
  'JPEG, PNG, or WebP; maximum 5 MB.': '支持 JPEG、PNG 或 WebP；最大 5 MB。',
  'Last 7 days': '最近 7 天',
  'Last 30 days': '最近 30 天',
  'Last 90 days': '最近 90 天',
  'Leader only': '仅领班',
  'Location map': '位置地图',
  'Management analytics': '管理分析',
  'Management summaries use accessible review records. Open check-ins are marked missing after 12 hours. Logged task hours are operational figures, not payroll-approved hours.': '管理汇总使用有权限查看的审核记录。未签退的签到会在 12 小时后标记为缺失。任务日志工时仅用于运营统计，并非工资核准工时。',
  'Maps and location review': '地图与位置审核',
  'Member work rows': '成员工作行',
  'Add member row': '添加成员行',
  'My submitted team logs': '我提交的团队日志',
  'No map point selected.': '尚未选择地图点。',
  'No radius result': '暂无范围结果',
  'No sites available': '暂无可用工地',
  'Open weekly team log': '打开周团队日志',
  'Outside site only': '仅工地范围外',
  'Person': '人员',
  'Productivity and site summary': '生产效率与工地汇总',
  'Reason for manual entry': '手动录入原因',
  'Record trend': '记录趋势',
  'Recorded changes and submissions': '已记录的变更和提交',
  'Recorded location history': '已记录的位置历史',
  'Reporting period': '报告周期',
  'Save as default view': '保存为默认视图',
  'Search and select one or more members per row. Add another row when the site, hours, or work activity changes.': '在每行搜索并选择一名或多名成员。工地、工时或工作内容变化时，请添加另一行。',
  'Select an attendance point or history row to review it.': '选择考勤点或历史记录行进行查看。',
  'Select several members in one row when they worked the same site, hours, and activity. Members can appear under different leaders in the same week.': '多名成员在同一工地、相同时段从事相同工作时，可在同一行选择。成员在同一周内可以出现在不同领班名下。',
  'Select, checkbox, and numeric responses are summarised automatically.': '选择题、复选框和数字回答会自动汇总。',
  'Submit weekly team log': '提交周团队日志',
  'Submitted work forms CSV': '已提交工作表单 CSV',
  'Supervisor desk': '主管工作台',
  'Team weekly logs': '团队周日志',
  'This changes review records, maps, analytics, sites, staff, and forms. It does not change your home department.': '这会更改审核记录、地图、分析、工地、员工和表单的查看范围，但不会更改您的所属部门。',
  'Week notes': '本周备注',
  'Week starting Monday': '周一开始的一周',
  'Weekly team work log': '周团队工作日志',
  'Worker class': '员工类别',
  'Review recorded check-in/out points and site boundaries. Dashed lines connect recorded events; they are not continuous GPS routes.': '审核已记录的签到/签退点和工地边界。虚线连接已记录的事件，并不代表连续的 GPS 路线。',
  'Site boundary': '工地边界',
  'Form response charts': '表单回答图表',
  'Expanded record photo': '放大的记录照片',
  'Admin quick actions': '管理快捷操作',
  'Attendance location map': '考勤位置地图',
  'Attendance steps': '考勤步骤',
  'Map legend': '地图图例',
  'Missing site map picker': '缺失工地地图选择器',
  'Site map picker': '工地地图选择器',
  'Weather, access, crew changes, or general notes': '天气、进场、班组变更或一般备注',
  'Working...': '处理中...',
  'Check this field and try again.': '请检查此字段后重试。',
  'Please fill out this field.': '请填写此字段。',
  'Enter a valid email address.': '请输入有效的电子邮箱地址。',
  'Enter a valid email address': '请输入有效的电子邮箱地址',
  'Invalid email or password': '电子邮箱或密码错误',
  'This account is resigned and cannot sign in': '此账号已离职，无法登录',
  'Name is required': '姓名为必填项',
  'A user with this email already exists': '使用此电子邮箱的用户已存在',
  'mark this worker resigned': '将此员工标记为离职',
  'reactivate this worker': '重新启用此员工',
  'Creating form...': '正在创建表单...',
  'Saving form...': '正在保存表单...',
  'Choose a worker, site, and valid attendance time.': '请选择员工、工地和有效的考勤时间。',
  'Could not add manual attendance.': '无法添加手动考勤记录。',
  'Could not submit the approved log.': '无法提交已批准日志。',
  'Select at least one member and complete every team work row before submitting.': '提交前，请至少选择一名成员并完整填写每一行团队工作记录。',
  'Weekly team work log submitted for supervisor review.': '周团队工作日志已提交主管审核。',
  'Could not submit the weekly team log.': '无法提交周团队日志。',
  'The browser did not return a fresh location. Please capture it again.': '浏览器未返回最新位置。请重新获取位置。',
  'This draft was saved with an earlier form version. Review it before submitting.': '此草稿使用较早的表单版本保存。提交前请检查。',
  'Could not prepare these photos. Choose them again before leaving this page.': '无法处理这些照片。离开此页面前请重新选择。',
  'Could not capture this Work Form draft.': '无法保存此工作表单草稿。',
  'Wait for the Work Form submission to finish.': '请等待工作表单提交完成。',
  'This Work Form still has unsaved changes.': '此工作表单仍有未保存的更改。',
  'Save changes to this pending check-in/check-out?': '是否保存对此待处理签到/签退记录的更改？',
  'Delete this pending check-in/check-out?': '是否删除此待处理的签到/签退记录？',
  'Discard this unsynced submission from this device? You can then create it again with corrected details or photos.': '是否从本设备放弃此未同步提交？之后可使用更正后的详细信息或照片重新创建。',
  'Double check: restore this record to the active review history?': '请再次确认：是否将此记录恢复到有效审核历史？',
  'Double check: hide this record and keep it in the rubbish bin for 30 days?': '请再次确认：是否隐藏此记录并在回收站中保留 30 天？',
  'Double check: save changes to this form submission?': '请再次确认：是否保存对此表单提交的更改？',
  'Double check: save changes to this weekly team log?': '请再次确认：是否保存对此周团队日志的更改？',
  'Double check: save changes to this task log?': '请再次确认：是否保存对此任务日志的更改？',
  'Double check: save changes to this check-in/check-out record?': '请再次确认：是否保存对此签到/签退记录的更改？',
  'Review desk': '\u5ba1\u6838\u5de5\u4f5c\u53f0',
  'Validate field records': '\u5ba1\u6838\u73b0\u573a\u8bb0\u5f55',
  'Choose a record from the inbox, review its evidence, then decide or adjust it without losing your place.': '\u4ece\u5f85\u529e\u5217\u8868\u4e2d\u9009\u62e9\u8bb0\u5f55\uff0c\u67e5\u770b\u51ed\u8bc1\u540e\u8fdb\u884c\u5ba1\u6279\u6216\u8c03\u6574\uff0c\u65e0\u9700\u53cd\u590d\u6eda\u52a8\u3002',
  'Inbox': '\u5f85\u529e',
  'Matching records': '\u5339\u914d\u8bb0\u5f55',
  'Select to review': '\u9009\u62e9\u540e\u5ba1\u6838',
  'Review records': '\u5ba1\u6838\u8bb0\u5f55',
  'Record detail': '\u8bb0\u5f55\u8be6\u60c5',
  'Select a record': '\u9009\u62e9\u4e00\u6761\u8bb0\u5f55',
  'Loading': '\u52a0\u8f7d\u4e2d',
  'Selected record navigation': '\u5df2\u9009\u8bb0\u5f55\u5bfc\u822a',
  'Previous review record': '\u4e0a\u4e00\u6761\u5ba1\u6838\u8bb0\u5f55',
  'Previous record': '\u4e0a\u4e00\u6761\u8bb0\u5f55',
  'Next review record': '\u4e0b\u4e00\u6761\u5ba1\u6838\u8bb0\u5f55',
  'Next record': '\u4e0b\u4e00\u6761\u8bb0\u5f55',
  'Choose a record from the inbox to see its full details and review actions.': '\u4ece\u5f85\u529e\u5217\u8868\u4e2d\u9009\u62e9\u8bb0\u5f55\uff0c\u67e5\u770b\u5b8c\u6574\u8be6\u60c5\u548c\u5ba1\u6838\u64cd\u4f5c\u3002',
  'No records match the current filters.': '\u6ca1\u6709\u7b26\u5408\u5f53\u524d\u7b5b\u9009\u6761\u4ef6\u7684\u8bb0\u5f55\u3002',
  'Read only': '\u53ea\u8bfb',
  'Live': '\u5b9e\u65f6',
  'Outside site': '\u5de5\u5730\u8303\u56f4\u5916',
  'Team log': '\u56e2\u961f\u8bb0\u5f55',
  'Manual entry': '\u624b\u52a8\u5f55\u5165',
  'My workday': '\u6211\u7684\u5de5\u4f5c\u65e5',
  'Live status': '\u5b9e\u65f6\u72b6\u6001',
  'Worker tasks': '\u5de5\u4f5c\u4efb\u52a1',
  'Three quick steps save your time and location for supervisor review.': '\u4e09\u4e2a\u7b80\u5355\u6b65\u9aa4\u5373\u53ef\u4fdd\u5b58\u65f6\u95f4\u548c\u4f4d\u7f6e\uff0c\u4f9b\u4e3b\u7ba1\u5ba1\u6838\u3002',
  'Where are you working?': '\u60a8\u5728\u54ea\u4e2a\u5de5\u5730\u5de5\u4f5c\uff1f',
  'Verify you are at the site.': '\u786e\u8ba4\u60a8\u5df2\u5230\u8fbe\u5de5\u5730\u3002',
  'Save the correct shift action.': '\u4fdd\u5b58\u6b63\u786e\u7684\u73ed\u6b21\u64cd\u4f5c\u3002',
  'Attendance': '\u8003\u52e4',
  'Follow the highlighted step. It usually takes less than a minute.': '\u6309\u7167\u9ad8\u4eae\u6b65\u9aa4\u64cd\u4f5c\uff0c\u901a\u5e38\u4e0d\u5230\u4e00\u5206\u949f\u3002',
  'Choose the site where you are physically working now.': '\u9009\u62e9\u60a8\u5f53\u524d\u5b9e\u9645\u5de5\u4f5c\u7684\u5de5\u5730\u3002',
  'Your attendance keeps the captured time and location.': '\u8003\u52e4\u8bb0\u5f55\u4f1a\u4fdd\u7559\u83b7\u53d6\u7684\u65f6\u95f4\u548c\u4f4d\u7f6e\u3002',
  'Saved securely and visible in My history after submission.': '\u5b89\u5168\u4fdd\u5b58\uff0c\u63d0\u4ea4\u540e\u53ef\u5728\u201c\u6211\u7684\u5386\u53f2\u201d\u4e2d\u67e5\u770b\u3002',
  'Site selected': '\u5df2\u9009\u62e9\u5de5\u5730',
  'Choose a site first': '\u8bf7\u5148\u9009\u62e9\u5de5\u5730',
  'Tap Step 2 to confirm your current location.': '\u70b9\u51fb\u7b2c 2 \u6b65\u786e\u8ba4\u5f53\u524d\u4f4d\u7f6e\u3002',
  'Your location can be confirmed after Step 1.': '\u5b8c\u6210\u7b2c 1 \u6b65\u540e\u5373\u53ef\u786e\u8ba4\u4f4d\u7f6e\u3002',
  'Site check': '\u5de5\u5730\u8303\u56f4\u68c0\u67e5',
  'Inside site area': '\u5728\u5de5\u5730\u8303\u56f4\u5185',
  'Outside site area': '\u5728\u5de5\u5730\u8303\u56f4\u5916',
  'Select a site to check distance': '\u9009\u62e9\u5de5\u5730\u4ee5\u68c0\u67e5\u8ddd\u79bb',
  'Location details': '\u4f4d\u7f6e\u8be6\u60c5',
  'Task form': '\u4efb\u52a1\u8868\u5355',
  'Basic task log': '\u57fa\u672c\u4efb\u52a1\u8bb0\u5f55',
  'Choose a person, site, and work date.': '\u8bf7\u9009\u62e9\u4eba\u5458\u3001\u5de5\u5730\u548c\u5de5\u4f5c\u65e5\u671f\u3002',
  'Enter the task summary.': '\u8bf7\u8f93\u5165\u4efb\u52a1\u6458\u8981\u3002',
  'log': '\u8bb0\u5f55',
  'Group': '\u90e8\u95e8',
  'Super admin': '\u8d85\u7ea7\u7ba1\u7406\u5458',
  'Daily work summary for site activity.': '现场日工汇总。',
  'Reusable inspection checklist with conditionals, formulas, repeat rows, and a signature.': '可重复使用的检查表，包含条件字段、公式、重复行和签名。',
  'Daywork log form': '日工记录表',
  'General Daywork Form matching the site daywork PDF layout.': '\u5339\u914d\u73b0\u573a\u65e5\u5de5 PDF \u7248\u5f0f\u7684\u901a\u7528\u65e5\u5de5\u8868\u3002',
  'General Daywork Form with repeatable teams and calculated man-hours.': '\u5e26\u53ef\u91cd\u590d\u73ed\u7ec4\u548c\u81ea\u52a8\u8ba1\u7b97\u4eba\u5de5\u65f6\u7684\u901a\u7528\u65e5\u5de5\u8868\u3002',
  'Site details': '\u5de5\u5730\u8be6\u60c5',
  'Client': '\u5ba2\u6237',
  'Details': '\u8be6\u60c5',
  'SI number': 'SI \u7f16\u53f7',
  'Building': '\u697c\u680b',
  'Level': '\u697c\u5c42',
  'Gridline': '\u8f74\u7ebf',
  'Team 1': '\u7b2c 1 \u7ec4',
  'Working Hours-Team 1': '\u7b2c 1 \u7ec4\u5de5\u4f5c\u65f6\u95f4',
  'Total Man Hours--All Teams': '\u6240\u6709\u73ed\u7ec4\u603b\u5de5\u65f6',
  'Teams': '\u73ed\u7ec4',
  'Team': '\u73ed\u7ec4',
  'Number of people': '\u4eba\u6570',
  'Working time': '\u5de5\u4f5c\u65f6\u95f4',
  'Team man hours': '\u73ed\u7ec4\u4eba\u5de5\u65f6',
  'Break': '\u4f11\u606f',
  'No break': '\u65e0\u4f11\u606f',
  '15 minutes': '15 \u5206\u949f',
  '30 minutes': '30 \u5206\u949f',
  '45 minutes': '45 \u5206\u949f',
  '1 hour': '1 \u5c0f\u65f6',
  'Job description': '\u5de5\u4f5c\u63cf\u8ff0',
  'Dimension': '\u5c3a\u5bf8',
  'Site Manager Name': '\u5de5\u5730\u7ecf\u7406\u59d3\u540d',
  'Work completed': '完成工作',
  'Materials used': '使用材料',
  'Worker signature': '员工签名',
  'Pre-start checks': '开工前检查',
  'Area': '区域',
  'Work time': '工作时间',
  'Workers': '员工人数',
  'Total worker hours': '总工时',
  'Result': '结果',
  'Issue details': '问题详情',
  'Materials': '材料',
  'Material': '材料',
  'Quantity': '数量',
  'Pass': '通过',
  'Fail': '不通过',
  'N/A': '不适用',
  'Field command centre': '现场指挥中心',
  'Field Operations': '现场作业',
  'Light mode': '浅色模式',
  'Dark mode': '深色模式',
  'Install App': '安装应用',
  'Update App': '更新应用',
  'Log out': '退出登录',
  'Sign in': '登录',
  'Sign in to continue.': '请登录后继续。',
  'Invited accounts only.': '仅限受邀账号。',
  'Sign in with the account provided by your supervisor. Contact your supervisor if you need access.': '请使用主管提供的账号登录。如需访问权限，请联系您的主管。',
  'Example: Queen Street Fitout': '示例：Queen Street Fitout',
  'Street address or site note': '街道地址或工地备注',
  'Example: unloading scaffold tubes, setting base plates, final site clean-up': '示例：卸脚手架管、安装底座、最后清理工地',
  'Site, note, task, status': '工地、备注、任务、状态',
  'Worker, site, note, task': '员工、工地、备注、任务',
  'Name, address, radius': '名称、地址、半径',
  'Name, email, role, status': '姓名、邮箱、角色、状态',
  'Inspection form': '检查表',
  'Basic scaffold/site inspection checklist.': '基础脚手架/工地检查清单。',
  'Inspection area': '检查区域',
  'Inspection result': '检查结果',
  'Needs action': '需要处理',
  'Issues found': '发现的问题',
  'Follow up required': '需要跟进',
  'Tool deduction form': '工具扣款表',
  'Record missing/damaged tools or deductions.': '记录遗失、损坏工具或扣款。',
  'Tool name': '工具名称',
  'Reason': '原因',
  'Lost': '遗失',
  'Damaged': '损坏',
  'Returned incomplete': '归还不完整',
  'Other': '其他',
  'section|Pre-start checks\ntext|Area|required\ntime_range|Work time|required\nnumber|Workers|required\nformula|Total worker hours||work_time * workers\nselect|Result|required|Pass,Fail,N/A\ntextarea|Issue details|required||show_if=result=Fail\nrepeat|Materials||min=0|max=12\n>text|Material|required\n>number|Quantity|required\nsignature|Worker signature|required': 'section|开工前检查\ntext|区域|required\ntime_range|工作时间|required\nnumber|员工人数|required\nformula|总工时||work_time * workers\nselect|结果|required|Pass,Fail,N/A\ntextarea|问题详情|required||show_if=result=Fail\nrepeat|材料||min=0|max=12\n>text|材料|required\n>number|数量|required\nsignature|员工签名|required',
  'Use it like an app': '像手机应用一样使用',
  'Download this app to your home screen from a supported browser.': '在支持的浏览器中把此应用添加到手机主屏幕。',
  'Download App': '下载应用',
  'How to Install': '如何安装',
  'App Installed': '已安装',
  'Email': '邮箱',
  'Password': '密码',
  'Create staff account': '创建员工账号',
  'Verify your email before choosing a department.': '选择部门前，请先验证邮箱。',
  'Send verification code': '发送验证码',
  'Verification code': '验证码',
  'Verify email': '验证邮箱',
  'Start over': '重新开始',
  'Email verified. Choose your department. A supervisor must activate the account.': '邮箱已验证。请选择部门。账号需要主管启用后才能登录。',
  'Select a department': '选择部门',
  'Name': '姓名',
  'Create account': '创建账号',
  'Sending verification code...': '正在发送验证码...',
  'Verification code sent. Check your email.': '验证码已发送，请检查邮箱。',
  'Verifying email...': '正在验证邮箱...',
  'Account created. A supervisor must activate it before you can sign in.': '账号已创建。主管启用账号后才能登录。',
  'Verify your email before creating an account.': '创建账号前，请先验证邮箱。',
  'Please wait before requesting another verification code': '请稍后再请求新的验证码',
  'Verification request is invalid': '验证请求无效',
  'Verification request is already verified': '该验证请求已完成',
  'Verification code has expired': '验证码已过期',
  'Too many verification attempts': '验证码尝试次数过多',
  'Verification code is incorrect': '验证码不正确',
  'Verified registration has expired': '已验证的注册请求已过期',
  'Could not send verification email': '无法发送验证邮件',
  'Registration email service is not configured': '注册邮件服务尚未配置',
  'Today': '今日',
  'Today’s attendance': '今日考勤',
  'Your attendance': '您的考勤',
  'Start or finish your shift': '开始或结束班次',
  'Choose your site, confirm your location, then tap one attendance button.': '选择工地，确认位置，然后点击一个考勤按钮。',
  'Choose site': '选择工地',
  'Confirm location': '确认位置',
  'Check in or out': '签到或签退',
  'Check in / out': '签到 / 签退',
  'Complete the steps in order. Notes and a photo are optional.': '请按顺序完成步骤。备注和照片为选填项。',
  'Step 1': '第 1 步',
  'Step 2:': '第 2 步：',
  'Step 2: Confirm my location': '第 2 步：确认我的位置',
  'Step 3': '第 3 步',
  "Choose today's site": '选择今天的工地',
  'Confirm my location': '确认我的位置',
  'Check in now': '现在签到',
  'Check out now': '现在签退',
  'Loading attendance status...': '正在加载考勤状态...',
  'Ready to check in.': '已准备签到。',
  'Ready to check out.': '已准备签退。',
  'Need a different attendance action?': '需要其他考勤操作吗？',
  'Need to check in instead?': '需要改为签到吗？',
  'Need to check out instead?': '需要改为签退吗？',
  'Use this only when the suggested action does not match your actual shift.': '仅当建议操作与您的实际班次不符时使用。',
  'Check in as a correction': '作为更正签到',
  'Check out as a correction': '作为更正签退',
  'Use attendance correction': '使用考勤更正',
  'Current status': '当前状态',
  'Next action': '下一步',
  'Attendance entries today': '今日考勤记录',
  'Last attendance': '最近考勤',
  'Waiting to sync': '等待同步',
  'Checked in': '已签到',
  'Not checked in': '未签到',
  'Check out when finished': '完工后签退',
  'Check in when you arrive': '到达后签到',
  'No attendance yet': '暂无考勤记录',
  'Choose your site first.': '请先选择工地。',
  'Now confirm your location.': '现在请确认位置。',
  'Ready. Tap the action you need.': '已准备。请点击需要的操作。',
  'Quick actions': '快捷操作',
  'Open check in / check out': '打开签到 / 签退',
  'Open daywork log': '打开日工记录',
  'Open work form': '打开工作表单',
  'Open my history': '打开我的记录',
  'Add missing site': '添加缺失工地',
  "Use when today's job is not listed": '今天的工地不在列表时使用',
  'Site name': '工地名称',
  'Address': '地址',
  'Use current location': '使用当前位置',
  'Latitude': '纬度',
  'Longitude': '经度',
  'Allowed radius metres': '允许半径（米）',
  'Add site': '添加工地',
  'Check': '签到',
  'Log': '记录',
  'Form': '表单',
  'History': '历史',
  'Check in / check out': '签到 / 签退',
  'Site': '工地',
  'Select a site': '选择工地',
  'Capture current location': '获取当前位置',
  'Save draft': '保存草稿',
  'No location captured yet.': '尚未获取位置。',
  'Select a site and capture your current location.': '请选择工地并获取当前位置。',
  'Check in': '签到',
  'Check out': '签退',
  'Check in/out': '签到/签退',
  'Notes and photo': '备注和照片',
  'Notes': '备注',
  'Optional site photo': '可选工地照片',
  'Daywork log': '日工记录',
  'Loading Daywork log form...': '正在加载日工记录表单...',
  'Work date': '工作日期',
  'Progress photos': '进度照片',
  'Submit daywork log': '提交日工记录',
  'Members': '成员',
  'Search members': '搜索成员',
  'Type a member name': '输入成员姓名',
  'No members selected yet.': '尚未选择成员。',
  'No members match this search.': '没有符合搜索条件的成员。',
  'Normal worker': '普通员工',
  'Leader': '领班',
  'Select members': '选择成员',
  'Work forms': '工作表单',
  'Select a form': '选择表单',
  'Photos': '照片',
  'Submit form': '提交表单',
  'My history': '我的历史',
  'Refresh': '刷新',
  'Find': '查找',
  'Type': '类型',
  'Type:': '类型：',
  'All': '全部',
  'Task logs': '任务记录',
  'Forms': '表单',
  'Status': '状态',
  'Pending': '待审核',
  'Approved': '已通过',
  'Rejected': '已拒绝',
  'Queued': '已排队',
  'Synced': '已同步',
  'Date': '日期',
  'Clear': '清除',
  'Edit': '编辑',
  'Cancel': '取消',
  'Review overview': '审核概览',
  'Exports': '导出',
  'Export attendance CSV': '导出考勤 CSV',
  'Export task logs CSV': '导出任务记录 CSV',
  'Document export': '文档导出',
  'Clear filters': '\u6e05\u9664\u7b5b\u9009',
  'Exporting...': '\u6b63\u5728\u5bfc\u51fa...',
  'From': '\u5f00\u59cb',
  'To': '\u7ed3\u675f',
  'Form type': '\u8868\u5355\u7c7b\u578b',
  'All submitted form types': '\u6240\u6709\u5df2\u63d0\u4ea4\u8868\u5355\u7c7b\u578b',
  'Daily task log sheets': '每日任务记录表',
  'Task photo report': '任务照片报告',
  'Daywork PDF': '日工 PDF',
  'Submitted work forms PDF': '已提交工作表单 PDF',
  'Submitted work forms HTML': '已提交工作表单 HTML',
  'Export document': '导出文档',
  'Review queue': '审核队列',
  '0 records': '0 条记录',
  'Records': '记录',
  'Audit history': '审计历史',
  'Supervisor changes': '主管修改',
  '0': '0',
  'Form name': '表单名称',
  'Description': '说明',
  'Fields': '字段',
  'Use one field per line: section, repeat, text, textarea, number, date, time_range, select, checkbox, formula, and signature. Select options or formula expressions go in the fourth column. Add rules such as show_if=result=Fail, min=1, or max=12 in later columns. Prefix repeat fields with >.': '每行一个字段：section、repeat、text、textarea、number、date、time_range、select、checkbox、formula 和 signature。下拉选项或公式写在第 4 列。可在后续列添加 show_if=result=Fail、min=1、max=12 等规则。重复字段请用 > 开头。',
  'Preview draft': '预览草稿',
  'Create form': '创建表单',
  'Sites': '工地',
  'Create site': '创建工地',
  'Find site': '查找工地',
  'Staff users': '员工用户',
  'Role': '角色',
  'Department': '部门',
  'No department': '无部门',
  'Global admin': '全局管理员',
  'global admin': '全局管理员',
  'Worker': '员工',
  'Supervisor': '主管',
  'Create user': '创建用户',
  'Find user': '查找用户',
  'Photo viewer': '照片查看器',
  'Photo': '照片',
  'Close': '关闭',
  'Previous': '上一张',
  'Next': '下一张',
  'Checking app status...': '正在检查应用状态...',
  'Checking connection...': '正在检查网络连接...',
  'Online': '在线',
  'Offline - submissions will wait': '离线 - 提交将等待同步',
  'Online - checking queued submissions': '在线 - 正在检查待同步提交',
  'Online - syncing': '在线 - 正在同步',
  'Online - queue checked': '在线 - 已检查同步队列',
  'Ready for sign in.': '可以登录。',
  'Offline mode is active. Login still works only if this browser session already has data cached.': '离线模式已启用。只有此浏览器已缓存会话数据时才能登录。',
  'A new app version is ready. Tap Update App to reload when you are ready.': '新版本已准备好。准备好后点击“更新应用”重新加载。',
  'A new app version is ready. Your Work Form will be saved before the app reloads.': '新版本已准备好。应用重新加载前会先保存您的工作表单。',
  'Protecting your work': '保护您的工作',
  'Update paused': '更新已暂停',
  'This Work Form has changes that are not saved on this device. Updating now could lose them.': '此工作表单有尚未保存在本设备上的更改。现在更新可能会丢失这些内容。',
  'Wait for the Work Form submission to finish before updating.': '请等待工作表单提交完成后再更新。',
  'Try saving again': '重试保存',
  'Keep editing': '继续编辑',
  'Saving before update...': '更新前正在保存...',
  'Draft saved. Updating app...': '草稿已保存。正在更新应用...',
  'The app update is no longer waiting. Your Work Form draft is saved.': '应用更新已不再等待。您的工作表单草稿已保存。',
  'Could not start the app update. Your Work Form draft is saved; try Update App again.': '无法启动应用更新。您的工作表单草稿已保存；请再次尝试“更新应用”。',
  'Updating app...': '正在更新应用...',
  'Signing in with the backend...': '正在通过后端登录...',
  'Signing in...': '正在登录...',
  'Creating account...': '正在创建账号...',
  'Sending code...': '正在发送验证码...',
  'Verifying...': '正在验证...',
  'Capturing...': '正在获取...',
  'Checking in...': '正在签到...',
  'Checking out...': '正在签退...',
  'Submitting daywork...': '正在提交日工记录...',
  'Submitting form...': '正在提交表单...',
  'Changes save automatically on this device.': '更改会自动保存在本设备上。',
  'Saving draft...': '正在保存草稿...',
  'Draft saved on this device.': '草稿已保存在本设备上。',
  'Changes not saved. Keep this page open and try again.': '更改尚未保存。请保持此页面打开并重试。',
  'Your Work Form is not saved yet. Keep editing and try again before logging out.': '您的工作表单尚未保存。请继续编辑，并在退出登录前重试。',
  'Your session expired, but this Work Form is not saved on this device. Keep this page open and try saving again.': '您的会话已过期，但此工作表单尚未保存在本设备上。请保持此页面打开并重试保存。',
  'Draft restored on this device.': '已恢复本设备上的草稿。',
  'Submitting weekly log...': '正在提交周团队记录...',
  'Adding site...': '正在添加工地...',
  'Adding attendance...': '正在添加考勤...',
  'Submitting approved log...': '正在提交已批准记录...',
  'Approving...': '正在批准...',
  'Rejecting...': '正在拒绝...',
  'Updating...': '正在更新...',
  'Dismiss notification': '关闭通知',
  'Creating staff account...': '正在创建员工账号...',
  'Your saved backend session expired. Please sign in again.': '已保存的后端会话已过期。请重新登录。',
  'Your backend session expired. Please sign in again.': '后端会话已过期。请重新登录。',
  'Using your saved sign-in while offline. Some backend features will sync when you reconnect.': '离线时使用已保存的登录状态。重新联网后部分后端功能会同步。',
  'No user signed in.': '没有用户登录。',
  'No sync has run yet.': '尚未同步。',
  'Offline mode is active. Queued entries will sync later.': '离线模式已启用。排队记录稍后会同步。',
  'You are back online. Queued records have been checked for sync.': '已恢复联网。已检查排队记录同步。',
  'You are offline. New submissions will stay on this device until you reconnect.': '当前离线。新的提交会保存在本设备，重新联网后再同步。',
  'This app is already installed on this device.': '此应用已安装在本设备上。',
  'On iPhone or iPad, use Safari Share, then Add to Home Screen.': '在 iPhone 或 iPad 上，请使用 Safari 的分享按钮，然后选择“添加到主屏幕”。',
  'Use the browser menu to install or add it to your home screen.': '请使用浏览器菜单安装，或添加到主屏幕。',
  'Tap Download App to install it on this device.': '点击“下载应用”即可安装到本设备。',
  'Attendance draft saved on this device.': '考勤草稿已保存在本设备。',
  'Geolocation is not available in this browser.': '此浏览器不支持地理定位。',
  'Capturing current location...': '正在获取当前位置...',
  'Please select a site first.': '请先选择工地。',
  'Please capture your location before submitting attendance.': '提交考勤前请先获取位置。',
  'Please select a valid site first.': '请先选择有效工地。',
  'Could not submit attendance.': '无法提交考勤。',
  'Attendance photo': '考勤照片',
  'Attendance draft photo': '考勤草稿照片',
  'Captured location': '已获取位置',
  'Accuracy': '精度',
  'Time': '时间',
  'Site radius:': '工地半径：',
  'Inside': '范围内',
  'Outside': '范围外',
  'Select a site to check distance before submitting.': '提交前请选择工地以检查距离。',
  'Daywork draft saved on this device.': '日工草稿已保存在本设备。',
  'No active Daywork log form is available.': '没有可用的日工记录表单。',
  'Ask a supervisor to create or activate a form named Daywork log form.': '请让主管创建或启用名为 Daywork log form 的表单。',
  'Site and work date are required.': '工地和工作日期为必填项。',
  'Could not submit Daywork log.': '无法提交日工记录。',
  'Daywork photo': '日工照片',
  'Daywork draft photo': '日工草稿照片',
  'Choose a form first.': '请先选择表单。',
  'Could not submit form.': '无法提交表单。',
  'Could not load work forms.': '无法加载工作表单。',
  'Form photo': '表单照片',
  'Unassigned site': '未分配工地',
  'This browser does not support location capture.': '此浏览器不支持位置获取。',
  'Capturing current location for the new site...': '正在为新工地获取当前位置...',
  'Current location added to the site form.': '当前位置已添加到工地表单。',
  'Location permission was denied or timed out. Enter the site coordinates manually.': '位置权限被拒绝或超时。请手动输入工地坐标。',
  'Site latitude, longitude, and radius must be valid numbers.': '工地纬度、经度和半径必须是有效数字。',
  'Site added. You can select it now.': '工地已添加，现在可以选择。',
  'Could not add site.': '无法添加工地。',
  'Signed in as': '登录身份',
  'Entries today': '今日记录',
  'Last check in': '最近签到',
  'Last check out': '最近签退',
  'Queued offline': '离线排队',
  'No records found yet.': '尚未找到记录。',
  'No notes added.': '未添加备注。',
  'No answers provided.': '未填写答案。',
  'No summary provided.': '未填写摘要。',
  'Form submission': '表单提交',
  'Task log': '任务记录',
  'Location:': '位置：',
  'Site radius': '工地半径',
  'Hours:': '工时：',
  'Form:': '表单：',
  'Sync:': '同步：',
  'Edit pending attendance': '编辑待审核考勤',
  'Save attendance': '保存考勤',
  'Double check before saving. This changes backend records.': '保存前请仔细确认。此操作会修改后端记录。',
  'This record cannot be edited here.': '此记录不能在这里编辑。',
  'Pending attendance updated.': '待审核考勤已更新。',
  'Could not update attendance.': '无法更新考勤。',
  'This record cannot be deleted here.': '此记录不能在这里删除。',
  'Attendance deleted.': '考勤已删除。',
  'Could not delete record.': '无法删除记录。',
  'Delete': '删除',
  'Export': '导出',
  'Export format': '导出格式',
  'Approve': '通过',
  'Reject': '拒绝',
  'Daily log HTML': '每日记录 HTML',
  'Photo report HTML': '照片报告 HTML',
  'CSV row': 'CSV 行',
  'Form HTML': '表单 HTML',
  'Form PDF': '表单 PDF',
  'Backend history is unreachable. Showing records saved on this device only.': '无法连接后端历史记录。仅显示本设备保存的记录。',
  'Needs review': '待审核',
  'Reviewed': '已审核',
  'Source': '来源',
  'Backend': '后端',
  'This device': '本设备',
  'Backend approvals are unreachable. Showing records saved on this device only.': '无法连接后端审核数据。仅显示本设备保存的记录。',
  'Attendance CSV exported.': '考勤 CSV 已导出。',
  'Could not export attendance CSV.': '无法导出考勤 CSV。',
  'Task logs CSV exported.': '任务记录 CSV 已导出。',
  'Could not export task logs CSV.': '无法导出任务记录 CSV。',
  'Task photo report exported.': '任务照片报告已导出。',
  'Work form submissions exported.': '工作表单提交已导出。',
  'Work form submissions PDF exported.': '工作表单提交 PDF 已导出。',
  'Daywork PDF exported.': '日工 PDF 已导出。',
  'Daily task log sheets exported.': '每日任务记录表已导出。',
  'Could not export document.': '无法导出文档。',
  'Only backend records can be exported.': '只有后端记录可以导出。',
  'Task log CSV row exported.': '任务记录 CSV 行已导出。',
  'Form submission exported.': '表单提交已导出。',
  'Form submission PDF exported.': '表单提交 PDF 已导出。',
  'This submission is not a Daywork form.': '此提交不是日工表单。',
  'Form submission CSV row exported.': '表单提交 CSV 行已导出。',
  'Daily task log exported.': '每日任务记录已导出。',
  'Could not export record.': '无法导出记录。',
  'No supervisor changes have been recorded yet.': '尚未记录主管修改。',
  'Audit history is unavailable.': '审计历史不可用。',
  'Only backend records can be adjusted by a supervisor.': '只有后端记录可以由主管调整。',
  'Form submissions can be approved or rejected, but not adjusted here yet.': '表单提交可以通过或拒绝，但目前还不能在这里调整。',
  'Edit task log': '编辑任务记录',
  'Task summary': '任务摘要',
  'Safety notes': '安全备注',
  'Hours worked': '工作小时',
  'Save task log': '保存任务记录',
  'Task log updated.': '任务记录已更新。',
  'Could not update task log.': '无法更新任务记录。',
  'Edit attendance': '编辑考勤',
  'Accuracy metres': '精度（米）',
  'Attendance record updated.': '考勤记录已更新。',
  'Could not update attendance record.': '无法更新考勤记录。',
  'No site': '无工地',
  'No sites found yet.': '尚未找到工地。',
  'No address added': '未添加地址',
  'Lat': '纬度',
  'Lng': '经度',
  'Edit site': '编辑工地',
  'Staff users are unavailable.': '员工用户不可用。',
  'Could not load staff users.': '无法加载员工用户。',
  'No users found yet.': '尚未找到用户。',
  'resigned worker': '已离职员工',
  'Edit user': '编辑用户',
  'Mark resigned': '标记离职',
  'Reactivate': '重新启用',
  'Add at least one form field.': '请至少添加一个表单字段。',
  'Work form created.': '工作表单已创建。',
  'Could not create work form.': '无法创建工作表单。',
  'Untitled work form': '未命名工作表单',
  'Add fields to preview this form.': '添加字段后可预览此表单。',
  'Worker preview': '员工预览',
  'Worker selects site': '员工选择工地',
  'Hide preview': '隐藏预览',
  'Preview': '预览',
  'Edit work form': '编辑工作表单',
  'Save form': '保存表单',
  'Work form updated.': '工作表单已更新。',
  'Could not update work form.': '无法更新工作表单。',
  'No forms found yet.': '尚未找到表单。',
  'No description': '无说明',
  'Section:': '小节：',
  'time range': '时间范围',
  'formula': '公式',
  'repeat': '重复',
  'Archive': '归档',
  'Activate': '启用',
  'Work form activated.': '工作表单已启用。',
  'Work form archived.': '工作表单已归档。',
  'Site created and added to worker forms.': '工地已创建并添加到员工表单。',
  'Could not create site.': '无法创建工地。',
  'Worker marked resigned.': '员工已标记为离职。',
  'Worker reactivated.': '员工已重新启用。',
  'Could not update worker status.': '无法更新员工状态。',
  'New password (optional)': '新密码（可选）',
  'Active': '在职',
  'Resigned': '离职',
  'Save user': '保存用户',
  'Staff user updated.': '员工用户已更新。',
  'Could not update staff user.': '无法更新员工用户。',
  'Save site': '保存工地',
  'Site updated.': '工地已更新。',
  'Could not update site.': '无法更新工地。',
  'Staff user created.': '员工用户已创建。',
  'Could not create staff user.': '无法创建员工用户。',
  'Subsection': '小节',
  'Repeatable section': '可重复小节',
  'Add row': '添加行',
  'Remove': '移除',
  'Start time': '开始时间',
  'End time': '结束时间',
  'Select': '选择',
  'Signature': '签名',
  'signature': '签名',
  'Write your signature inside the box.': '请在框内手写签名。',
  'Signed': '已签名',
  'Yes': '是',
  'No': '否',
  'Row': '行',
  'Field': '字段',
  'Unsupported queued record type.': '不支持的排队记录类型。',
  'Task log submitted for approval.': '任务记录已提交审核。',
  'Submission synced.': '提交已同步。',
  'Submission saved locally. Sign in again to sync it.': '提交已保存在本地。请重新登录后同步。',
  'Sign in again to sync queued submissions.': '请重新登录以同步排队提交。',
  'Queued submissions are already syncing.': '排队提交正在同步。',
  'The app could not start correctly. Check the browser console for details.': '应用无法正确启动。请查看浏览器控制台了解详情。',
  'Switch language to Chinese': '切换语言为中文',
  'Switch to light mode': '切换到浅色模式',
  'Switch to dark mode': '切换到深色模式',
  'pending': '待审核',
  'approved': '已通过',
  'rejected': '已拒绝',
  'queued': '已排队',
  'syncing': '同步中',
  'synced': '已同步',
  'record': '记录',
  'active': '在职',
  'archived': '已归档',
  'draft': '草稿',
  'worker': '员工',
  'supervisor': '主管',
  'attendance': '考勤',
  'task': '任务',
  'form': '表单',
  'change': '修改'
};

const ZH_PATTERNS = [
  [/^(\d+) of (\d+)$/, (match) => `${match[1]} / ${match[2]}`],
  [/^Saved at (.+)\.( Draft restored on this device\.)?$/, (match) => `已于 ${match[1]} 保存。${match[2] ? '已恢复本设备上的草稿。' : ''}`],
  [/^(\d+) exceptions?$/, (match) => `${match[1]} 个异常`],
  [/^(\d+) points?$/, (match) => `${match[1]} 个点`],
  [/^Review recorded for (.+)\.$/, (match) => `审核为 ${match[1]} 记录的内容。`],
  [/^Clear (.+) signature$/, (match) => {
    const label = match[1].replace(/\s+signature$/i, '');
    return `清除${translateText(label, 'zh')}签名`;
  }],
  [/^Drag (.+)$/, (match) => `拖动${translateText(match[1], 'zh')}`],
  [/^Move (.+) (up|down)$/, (match) => `${match[2] === 'up' ? '上移' : '下移'}${translateText(match[1], 'zh')}`],
  [/^Fields inside (.+)$/, (match) => `${translateText(match[1], 'zh')}内的字段`],
  [/^Unavailable field \((.+)\)$/, (match) => `不可用字段（${match[1]}）`],
  [/^(.+) has an invalid condition\.$/, (match) => `${translateText(match[1], 'zh')}的显示条件无效。`],
  [/^(.+) must come after the field used by its condition\.$/, (match) => `${translateText(match[1], 'zh')}必须位于显示条件所使用的字段之后。`],
  [/^(.+) needs a formula\.$/, (match) => `${translateText(match[1], 'zh')}需要填写公式。`],
  [/^(.+) uses unsupported formula characters\.$/, (match) => `${translateText(match[1], 'zh')}使用了不支持的公式字符。`],
  [/^(.+) must come after: (.+)\.$/, (match) => `${translateText(match[1], 'zh')}必须位于以下字段之后：${match[2]}。`],
  [/^Forms can include up to (\d+) fields\.$/, (match) => `每个表单最多可包含 ${match[1]} 个字段。`],
  [/^Field key "(.+)" is duplicated\.$/, (match) => `字段键“${match[1]}”重复。`],
  [/^(.+)… is longer than 160 characters\.$/, (match) => `${translateText(match[1], 'zh')}…超过 160 个字符。`],
  [/^(.+) cannot include the \| character\.$/, (match) => `${translateText(match[1], 'zh')}不能包含 | 字符。`],
  [/^(.+) has an unsupported type\.$/, (match) => `${translateText(match[1], 'zh')}使用了不支持的字段类型。`],
  [/^(.+) needs at least one option\.$/, (match) => `${translateText(match[1], 'zh')}至少需要一个选项。`],
  [/^(.+) options cannot include commas or \| characters\.$/, (match) => `${translateText(match[1], 'zh')}的选项不能包含逗号或 | 字符。`],
  [/^(.+) belongs to a missing repeating group\.$/, (match) => `${translateText(match[1], 'zh')}属于不存在的重复组。`],
  [/^(.+) minimum rows must be 0-(\d+)\.$/, (match) => `${translateText(match[1], 'zh')}的最少行数必须为 0-${match[2]}。`],
  [/^(.+) maximum rows must be 1-(\d+)\.$/, (match) => `${translateText(match[1], 'zh')}的最多行数必须为 1-${match[2]}。`],
  [/^(.+) maximum must be at least its minimum\.$/, (match) => `${translateText(match[1], 'zh')}的最大值不能小于最小值。`],
  [/^Line (\d+) needs a type and label\.$/, (match) => `第 ${match[1]} 行需要字段类型和标签。`],
  [/^Line (\d+) is not below a repeating group\.$/, (match) => `第 ${match[1]} 行不在重复组下方。`],
  [/^Could not move field\. (.+)$/, (match) => `无法移动字段。${translateText(match[1], 'zh')}`],
  [/^Move cancelled\. (.+)$/, (match) => `移动已取消。${translateText(match[1], 'zh')}`],
  [/^Moved (.+) to position (\d+) of (\d+)\.$/, (match) => `已将${translateText(match[1], 'zh')}移动到第 ${match[2]} 位，共 ${match[3]} 位。`],
  [/^Added (group )?field (.+)\.$/, (match) => `已添加${match[1] ? '组内' : ''}字段${translateText(match[2], 'zh')}。`],
  [/^Remove "(.+)" and its (\d+) group fields?\?$/, (match) => `是否移除“${translateText(match[1], 'zh')}”及其 ${match[2]} 个组内字段？`],
  [/^Could not remove field\. (.+)$/, (match) => `无法移除字段。${translateText(match[1], 'zh')}`],
  [/^Remove cancelled\. (.+)$/, (match) => `移除已取消。${translateText(match[1], 'zh')}`],
  [/^Remove (.+)$/, (match) => `移除${translateText(match[1], 'zh')}`],
  [/^Removed (.+)\.$/, (match) => `已移除${translateText(match[1], 'zh')}。`],
  [/^You are back online, but Sites are unavailable: (.+)$/, (match) => `网络已恢复，但工地数据不可用：${translateText(match[1], 'zh')}`],
  [/^Sites are unavailable: (.+)$/, (match) => `工地数据不可用：${translateText(match[1], 'zh')}`],
  [/^Online - last sync attempt (.+)$/, (match) => `在线 - 上次同步尝试：${match[1]}`],
  [/^Online - (\d+) submissions? need attention$/, (match) => `在线 - ${match[1]} 条提交需要处理`],
  [/^Online - (\d+) synced$/, (match) => `在线 - 已同步 ${match[1]} 条`],
  [/^Manual attendance added for (.+)\.$/, (match) => `已为 ${match[1]} 添加手动考勤记录。`],
  [/^(.+) The submitted draft could not be cleared from this device; do not submit it again after reloading\.$/, (match) => `${translateText(match[1], 'zh')} 已提交的草稿无法从本设备清除；重新加载后请勿再次提交。`],
  [/^Please include an '@' in the email address\..*$/, () => '请输入包含“@”的有效电子邮箱地址。'],
  [/^Please enter a part following '@'\..*$/, () => '请输入“@”后面的邮箱地址部分。'],
  [/^Double check: save changes to form "(.+)"\?$/, (match) => `请再次确认：是否保存对表单“${match[1]}”的更改？`],
  [/^Double check: (archive|activate) "(.+)"\?$/, (match) => `请再次确认：是否${match[1] === 'archive' ? '归档' : '启用'}“${match[2]}”？`],
  [/^Double check: (.+)\? Their previous records will stay attached to this account\.$/, (match) => `请再次确认：${translateText(match[1], 'zh')}？其以前的记录仍会关联到此账号。`],
  [/^Double check: save changes to user "(.+)"\?$/, (match) => `请再次确认：是否保存对用户“${match[1]}”的更改？`],
  [/^Double check: save changes to site "(.+)"\?$/, (match) => `请再次确认：是否保存对工地“${match[1]}”的更改？`],
  [/^Double check: add this (check out|check in) for (.+)\?$/, (match) => `请再次确认：是否为 ${match[2]} 添加此次${match[1] === 'check out' ? '签退' : '签到'}？`],
  [/^Double check: submit this approved (.+) for (.+)\?$/, (match) => `请再次确认：是否为 ${match[2]} 提交已批准的${translateText(match[1], 'zh')}？`],
  [/^(.+) (\d+) of (\d+)$/, (match) => `${translateText(match[1], 'zh')} ${match[2]} / ${match[3]}`],
  [/^Review (.+)$/, (match) => `\u5ba1\u6838 ${translateText(match[1], 'zh')}`],
  [/^Confirmed (.+) \u00b7 accuracy about (.+)m$/, (match) => `\u5df2\u786e\u8ba4 ${match[1]} \u00b7 \u7cbe\u5ea6\u7ea6 ${match[2]} \u7c73`],
  [/^(.+)m from (.+) \u00b7 (.+)m allowed$/, (match) => `\u8ddd ${match[2]} ${match[1]} \u7c73 \u00b7 \u5141\u8bb8 ${match[3]} \u7c73`],
  [/^Latitude (.+) \u00b7 Longitude (.+)$/, (match) => `\u7eac\u5ea6 ${match[1]} \u00b7 \u7ecf\u5ea6 ${match[2]}`],
  [/^Approved (.+) submitted for (.+)\.$/, (match) => `${translateText(match[1], 'zh')} \u5df2\u4e3a ${match[2]} \u63d0\u4ea4\u5e76\u901a\u8fc7\u3002`],
  [/^(.+) \*$/, (match) => `${translateText(match[1], 'zh')} *`],
  [/^Verification code sent\. Development code: (.+)$/, (match) => `验证码已发送。开发验证码：${match[1]}`],
  [/^Section: (.+)$/, (match) => `分组：${translateText(match[1], 'zh')}`],
  [/^(.+) \(time range\)$/, (match) => `${translateText(match[1], 'zh')}（时间段）`],
  [/^(.+) = (.+)$/, (match) => `${translateText(match[1], 'zh')} = ${match[2]}`],
  [/^(.+) \(repeat (.+)\)$/, (match) => `${translateText(match[1], 'zh')}（重复 ${match[2]}）`],
  [/^> (.+)$/, (match) => `> ${translateText(match[1], 'zh')}`],
  [/^Switch to (light|dark) mode$/, (match) => `切换到${match[1] === 'light' ? '浅色' : '深色'}模式`],
  [/^(.+) is signed in as (worker|supervisor)\.$/, (match) => `${match[1]} 已以${ZH_TEXT[match[2]] || match[2]}身份登录。`],
  [/^(.+) is signed in as (worker|supervisor)\. Last local sync: (.+)\.$/, (match) => `${match[1]} 已以${ZH_TEXT[match[2]] || match[2]}身份登录。上次本地同步：${match[3]}。`],
  [/^(.+) is signed in as (worker|supervisor)\. No sync has run yet\.$/, (match) => `${match[1]} 已以${ZH_TEXT[match[2]] || match[2]}身份登录。尚未同步。`],
  [/^(.+) is signed in as (worker|supervisor)\. Offline mode is active\. Queued entries will sync later\.$/, (match) => `${match[1]} 已以${ZH_TEXT[match[2]] || match[2]}身份登录。离线模式已启用，排队记录稍后会同步。`],
  [/^Last local sync: (.+)\.$/, (match) => `上次本地同步：${match[1]}。`],
  [/^Location captured successfully with approximately (.+)m accuracy\.$/, (match) => `位置获取成功，精度约 ${match[1]} 米。`],
  [/^Could not get location: (.+)$/, (match) => `无法获取位置：${match[1]}`],
  [/^(.+) queued record(s)? synced\.$/, (match) => `${match[1]} 条排队记录已同步。`],
  [/^(.+) queued record(s)? could not sync yet\.$/, (match) => `${match[1]} 条排队记录暂时无法同步。`],
  [/^(.+) of (.+) records$/, (match) => `${match[1]} / ${match[2]} 条记录`],
  [/^Record (approved|rejected)\.$/, (match) => `记录已${match[1] === 'approved' ? '通过' : '拒绝'}。`],
  [/^Could not mark record as (approved|rejected)\.$/, (match) => `无法将记录标记为${match[1] === 'approved' ? '通过' : '拒绝'}。`],
  [/^Check in - (.+)$/, (match) => `签到 - ${translateText(match[1], 'zh')}`],
  [/^Check out - (.+)$/, (match) => `签退 - ${translateText(match[1], 'zh')}`],
  [/^Task log - (.+)$/, (match) => `任务记录 - ${translateText(match[1], 'zh')}`],
  [/^(worker|supervisor) global$/, (match) => `${ZH_TEXT[match[1]] || match[1]} ${ZH_TEXT['global admin'] || '全局管理员'}`],
  [/^Worker (.+)$/, (match) => `员工 ${translateText(match[1], 'zh')}`],
  [/^Site (.+)$/, (match) => `工地 ${translateText(match[1], 'zh')}`],
  [/^Form (.+)$/, (match) => `表单 ${translateText(match[1], 'zh')}`],
  [/^ID (.+) \| (.+)$/, (match) => `编号 ${match[1]} | ${match[2]}`],
  [/^Lat (.+), Lng (.+)$/, (match) => `纬度 ${match[1]}，经度 ${match[2]}`],
  [/^Work date: (.+)$/, (match) => `工作日期：${match[1]}`],
  [/^(.+)[ ]{2}\|[ ]{2}(.+)[ ]{2}\|[ ]{2}Work date: (.+)$/, (match) => `${match[1]}  |  ${match[2]}  |  工作日期：${match[3]}`],
  [/^(.+)[ ]{2}\|[ ]{2}(.+)$/, (match) => `${match[1]}  |  ${match[2]}`],
  [/^.+ \| .+$/, (match) => match[0].split(' | ').map((part) => translateText(part, 'zh')).join(' | ')],
  [/^Inside - (.+)m from site$/, (match) => `范围内 - 距工地 ${match[1]} 米`],
  [/^Outside - (.+)m from site$/, (match) => `范围外 - 距工地 ${match[1]} 米`],
  [/^Inside - (.+)m from (.+) \((.+)m allowed\)$/, (match) => `范围内 - 距 ${match[2]} ${match[1]} 米（允许 ${match[3]} 米）`],
  [/^Outside - (.+)m from (.+) \((.+)m allowed\)$/, (match) => `范围外 - 距 ${match[2]} ${match[1]} 米（允许 ${match[3]} 米）`],
  [/^(.+) - (.+)$/, (match) => `${translateText(match[1], 'zh')} - ${translateText(match[2], 'zh')}`],
  [/^Latitude: (.+)$/, (match) => `纬度：${match[1]}`],
  [/^Longitude: (.+)$/, (match) => `经度：${match[1]}`],
  [/^Accuracy: (.+)m$/, (match) => `精度：${match[1]} 米`],
  [/^Time: (.+)$/, (match) => `时间：${match[1]}`],
  [/^(.+) submitted for approval\.$/, (match) => `${match[1]} 已提交审核。`],
  [/^(.+) saved to the backend and approved automatically\.$/, (match) => `${match[1]} 已保存到后端并自动通过。`],
  [/^(.+) saved to the backend for supervisor review\.$/, (match) => `${match[1]} 已保存到后端，等待主管审核。`],
  [/^(.+) saved locally\. Backend sync will retry when you reconnect\.$/, (match) => `${match[1]} 已保存在本地。重新联网后会重试后端同步。`],
  [/^(.+) saved offline and queued for later sync\.$/, (match) => `${match[1]} 已离线保存，并已排队稍后同步。`],
  [/^(.+) can include up to (.+) photos\. The first (.+) were kept\.$/, (match) => `${match[1]} 最多可包含 ${match[2]} 张照片。已保留前 ${match[3]} 张。`],
  [/^(.+) needs both start and end times\.$/, (match) => `${match[1]} 需要开始和结束时间。`],
  [/^(.+) is required\.$/, (match) => `${match[1]} 为必填项。`],
  [/^(.+) needs at least (.+) row\(s\)\.$/, (match) => `${match[1]} 至少需要 ${match[2]} 行。`],
  [/^(.+) can include up to (.+) row\(s\)\.$/, (match) => `${match[1]} 最多可包含 ${match[2]} 行。`],
  [/^(.+) row$/, (match) => `${match[1]} 行`],
  [/^(.+) signature$/, (match) => `${translateText(match[1], 'zh')} 签名`],
  [/^Photo (.+) of (.+)$/, (match) => `照片 ${match[1]} / ${match[2]}`],
  [/^Record photo (.+)$/, (match) => `记录照片 ${match[1]}`],
  [/^(.+) (\d+)$/, (match) => `${translateText(match[1], 'zh')} ${match[2]}`]
];

const originalTextNodes = new WeakMap();
const originalAttributes = new WeakMap();

let currentLanguage = readInitialLanguage();
let isApplying = false;
let observer = null;

function normaliseLanguage(language) {
  return SUPPORTED_LANGUAGES.has(language) ? language : DEFAULT_LANGUAGE;
}

function readInitialLanguage() {
  try {
    return normaliseLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function storeLanguage(language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Language persistence is optional when storage is unavailable.
  }
}

function normaliseText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function translateText(value, language = currentLanguage) {
  const raw = String(value ?? '');
  if (language === 'en') return raw;

  const leading = raw.match(/^\s*/)?.[0] || '';
  const trailing = raw.match(/\s*$/)?.[0] || '';
  const text = normaliseText(raw);
  if (!text) return raw;
  if (PROTECTED_COMPANY_NAMES.has(text) || PROTECTED_TECHNICAL_TEXT.has(text)) return raw;

  const exact = ZH_TEXT[text];
  if (exact) return `${leading}${exact}${trailing}`;

  for (const [pattern, replacer] of ZH_PATTERNS) {
    const match = text.match(pattern);
    if (match) return `${leading}${replacer(match)}${trailing}`;
  }

  return raw;
}

function shouldSkipNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!element) return true;
  return Boolean(element.closest('script, style, textarea, [data-no-i18n], [data-language-toggle]'));
}

function shouldSkipAttributes(element) {
  if (!element) return true;
  return Boolean(element.closest('script, style, [data-no-i18n], [data-language-toggle]'));
}

function translateTextNode(node) {
  if (shouldSkipNode(node)) return;

  if (!originalTextNodes.has(node)) {
    originalTextNodes.set(node, node.nodeValue);
  }

  const original = originalTextNodes.get(node);
  const nextValue = currentLanguage === 'en' ? original : translateText(original, currentLanguage);
  if (node.nodeValue !== nextValue) {
    node.nodeValue = nextValue;
  }
}

function attributeStoreFor(element) {
  if (!originalAttributes.has(element)) {
    originalAttributes.set(element, {});
  }
  return originalAttributes.get(element);
}

function translateAttribute(element, attribute) {
  if (!element.hasAttribute(attribute) || shouldSkipAttributes(element)) return;

  const store = attributeStoreFor(element);
  if (!(attribute in store)) {
    store[attribute] = element.getAttribute(attribute);
  }

  const original = store[attribute];
  const nextValue = currentLanguage === 'en' ? original : translateText(original, currentLanguage);
  if (element.getAttribute(attribute) !== nextValue) {
    element.setAttribute(attribute, nextValue);
  }
}

function translateElement(element) {
  ['placeholder', 'title', 'aria-label', 'aria-roledescription', 'alt']
    .forEach((attribute) => translateAttribute(element, attribute));
}

export function setTranslatableText(element, value) {
  setTranslatableTextParts(element, [value]);
}

export function setTranslatableTextParts(element, values) {
  if (!element) return;

  element.textContent = '';
  (Array.isArray(values) ? values : [values]).forEach((value, index) => {
    const original = `${index ? ' ' : ''}${String(value ?? '')}`;
    const node = element.ownerDocument.createTextNode(original);
    originalTextNodes.set(node, original);
    node.nodeValue = currentLanguage === 'en' ? original : translateText(original, currentLanguage);
    element.appendChild(node);
  });
}

export function getTranslatableText(element) {
  if (!element) return '';

  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const values = [];
  let node = walker.nextNode();
  while (node) {
    values.push(originalTextNodes.get(node) ?? node.nodeValue ?? '');
    node = walker.nextNode();
  }
  return values.join('');
}

export function setTranslatableAttribute(element, attribute, value) {
  if (!element || !attribute) return;

  const original = String(value ?? '');
  const store = attributeStoreFor(element);
  store[attribute] = original;
  const nextValue = currentLanguage === 'en' ? original : translateText(original, currentLanguage);
  element.setAttribute(attribute, nextValue);
}

function translateTree(root = document.body) {
  if (!root || isApplying) return;

  isApplying = true;
  try {
    const textRoot = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
    }

    if (root.nodeType === Node.ELEMENT_NODE) {
      translateElement(root);
    }

    const walker = document.createTreeWalker(textRoot || document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      translateTextNode(node);
      node = walker.nextNode();
    }

    (textRoot || document.body)
      .querySelectorAll?.('[placeholder], [title], [aria-label], [aria-roledescription], [alt]')
      .forEach(translateElement);
  } finally {
    isApplying = false;
  }
}

function renderLanguageMetadata(button) {
  const meta = LANGUAGE_META[currentLanguage];
  document.documentElement.lang = meta.htmlLang;
  document.documentElement.dataset.language = currentLanguage;
  document.title = meta.title;

  if (!button) return;
  button.textContent = meta.toggleText;
  button.setAttribute('aria-label', meta.toggleLabel);
  button.title = meta.toggleTitle;
  button.setAttribute('aria-pressed', String(currentLanguage === 'zh'));
}

function observeTranslations(root) {
  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    if (isApplying || currentLanguage === 'en') return;

    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => translateTree(node));
    });
  });

  observer.observe(root, {
    childList: true,
    subtree: true
  });
}

export function getCurrentLanguage() {
  return currentLanguage;
}

export function applyLanguage(root = document.body) {
  renderLanguageMetadata(document.querySelector('[data-language-toggle]'));
  translateTree(root);
}

export function setLanguage(language) {
  currentLanguage = normaliseLanguage(language);
  storeLanguage(currentLanguage);
  applyLanguage();
}

export function initLanguageToggle({ button, root = document.body, onChange = () => {} } = {}) {
  if (!button) return;

  renderLanguageMetadata(button);
  button.addEventListener('click', () => {
    setLanguage(currentLanguage === 'en' ? 'zh' : 'en');
    onChange(currentLanguage);
  });
  applyLanguage(root);
  observeTranslations(root);
}
