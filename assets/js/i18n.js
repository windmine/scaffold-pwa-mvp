const LANGUAGE_STORAGE_KEY = 'leader-language';
const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = new Set(['en', 'zh']);

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
  'Group': '\u90e8\u95e8',
  'Super admin': '\u8d85\u7ea7\u7ba1\u7406\u5458',
  'Daily work summary for site activity.': '现场日工汇总。',
  'Reusable inspection checklist with conditionals, formulas, repeat rows, and a signature.': '可重复使用的检查表，包含条件字段、公式、重复行和签名。',
  'Daywork log form': '日工记录表',
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
  'Use the account provided by your supervisor, or register a worker account below.': '请使用主管提供的账号登录，也可以在下面注册员工账号。',
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
  'Name': '姓名',
  'Create account': '创建账号',
  'Today': '今日',
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
  'Ready for sign in.': '可以登录。',
  'Offline mode is active. Login still works only if this browser session already has data cached.': '离线模式已启用。只有此浏览器已缓存会话数据时才能登录。',
  'A new app version is ready. Tap Update App to reload when you are ready.': '新版本已准备好。准备好后点击“更新应用”重新加载。',
  'Updating app...': '正在更新应用...',
  'Signing in with the backend...': '正在通过后端登录...',
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
  [/^(.+) \*$/, (match) => `${translateText(match[1], 'zh')} *`],
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
  [/^Check in - (.+)$/, (match) => `签到 - ${match[1]}`],
  [/^Check out - (.+)$/, (match) => `签退 - ${match[1]}`],
  [/^Task log - (.+)$/, (match) => `任务记录 - ${match[1]}`],
  [/^(.+) - (.+)$/, (match) => `${match[1]} - ${match[2]}`],
  [/^(worker|supervisor) global$/, (match) => `${ZH_TEXT[match[1]] || match[1]} ${ZH_TEXT['global admin'] || '全局管理员'}`],
  [/^Worker (.+)$/, (match) => `员工 ${match[1]}`],
  [/^Site (.+)$/, (match) => `工地 ${match[1]}`],
  [/^Form (.+)$/, (match) => `表单 ${match[1]}`],
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
  [/^(.+) signature$/, (match) => `${match[1]} 签名`],
  [/^Photo (.+) of (.+)$/, (match) => `照片 ${match[1]} / ${match[2]}`],
  [/^Record photo (.+)$/, (match) => `记录照片 ${match[1]}`]
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

function translateText(value, language = currentLanguage) {
  const raw = String(value ?? '');
  if (language === 'en') return raw;

  const leading = raw.match(/^\s*/)?.[0] || '';
  const trailing = raw.match(/\s*$/)?.[0] || '';
  const text = normaliseText(raw);
  if (!text) return raw;

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
  ['placeholder', 'title', 'aria-label', 'alt'].forEach((attribute) => translateAttribute(element, attribute));
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

    (textRoot || document.body).querySelectorAll?.('[placeholder], [title], [aria-label], [alt]').forEach(translateElement);
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
