/**
 * Thai UI strings — Workbench shell, Home, settings, shared UI kit, MemNEX (web + engine), API messages.
 */
export const thCore: Record<string, string> = {
  /* ── App / page titles ── */
  'Local tools. Local data. Local control.': 'เครื่องมือในเครื่อง ข้อมูลในเครื่อง ควบคุมได้เองทั้งหมด',
  'This page isn’t part of NEX Workbench.': 'หน้านี้ไม่ได้เป็นส่วนหนึ่งของ NEX Workbench',
  'Back to Home': 'กลับไปหน้าหลัก',
  'Settings · NEX Workbench': 'ตั้งค่า · NEX Workbench',

  /* ── MemNEX web ── */
  'High memory': 'ใช้หน่วยความจำสูง',
  'Recommended': 'แนะนำ',
  'System': 'ระบบ',
  'MemNEX could not build a cleanup preview.': 'MemNEX สร้างตัวอย่างการเคลียร์ไม่ได้',
  'Cleanup': 'เคลียร์พื้นที่',
  '{s} closed.': 'ปิด {s} แล้ว',
  '{s} is still running. The OS may have blocked the request.': '{s} ยังทำงานอยู่ ระบบปฏิบัติการอาจบล็อกคำขอนี้',
  '{s} was force closed.': 'บังคับปิด {s} แล้ว',
  '{s} restarted with a fresh memory footprint.': 'รีสตาร์ท {s} แล้ว หน่วยความจำเริ่มใหม่ตั้งแต่ต้น',
  'Reopening {s}…': 'กำลังเปิด {s} อีกครั้ง…',
  'MemNEX will suggest {s} again when it’s idle.': 'MemNEX จะแนะนำ {s} อีกครั้งเมื่อไม่ได้ใช้งาน',
  '{s}: Process no longer exists.': '{s}: ไม่พบโปรเซสนี้แล้ว',
  '{s} is now protected.': 'ป้องกัน {s} ไว้แล้ว',
  '{s} is no longer protected.': 'เลิกป้องกัน {s} แล้ว',
  'MemNEX is turned off.': 'MemNEX ถูกปิดอยู่',
  'Reading your system…': 'กำลังอ่านข้อมูลระบบ…',
  'MemNEX can’t reach its local service.': 'MemNEX เชื่อมต่อเซอร์วิสในเครื่องไม่ได้',
  'Smart Cleanup': 'เคลียร์อัจฉริยะ',
  'System health · diagnosis': 'สุขภาพระบบ · การวินิจฉัย',
  'idle apps': 'แอปที่ไม่ได้ใช้งาน',
  'incl. {n} file cache': 'รวมแคชไฟล์ {n}',
  '{n}% of total': '{n}% ของทั้งหมด',
  'Not reported by OS': 'ระบบปฏิบัติการไม่ได้รายงาน',
  'Growing now': 'กำลังเพิ่มขึ้น',
  'of {n} · not growing': 'จาก {n} · ไม่เพิ่มขึ้น',
  'across {n} cores': 'จาก {n} คอร์',
  'Top memory consumers': 'แอปที่ใช้หน่วยความจำมากที่สุด',
  'Grouped by application': 'จัดกลุ่มตามแอปพลิเคชัน',
  'All apps': 'แอปทั้งหมด',
  'This machine': 'เครื่องนี้',
  'Processor': 'โปรเซสเซอร์',
  'Uptime': 'เวลาทำงานต่อเนื่อง',
  'Search applications': 'ค้นหาแอปพลิเคชัน',
  'Filter': 'ตัวกรอง',
  'Name': 'ชื่อ',
  'Application': 'แอปพลิเคชัน',
  '{s} (PID {n})': '{s} (PID {n})',
  'No applications match “': 'ไม่มีแอปพลิเคชันที่ตรงกับ “',
  'smaller apps under 50 MB': 'แอปขนาดเล็กที่ต่ำกว่า 50 MB',
  'Command-line & background': 'Command-line และเบื้องหลัง',
  'Dev servers, runtimes and tools': 'Dev server, runtime และเครื่องมือ',
  'These aren’t apps with a Quit menu, so MemNEX stops them one process at a time. Expand a row to choose which.':
    'รายการเหล่านี้ไม่ใช่แอปที่มีเมนู Quit ดังนั้น MemNEX จะหยุดทีละโปรเซส ขยายแถวเพื่อเลือกโปรเซสที่ต้องการ',
  'Cleanup complete': 'เคลียร์เสร็จแล้ว',
  'released by closed apps in': 'ได้คืนจากแอปที่ปิดภายใน',
  'System memory before → after': 'หน่วยความจำระบบ ก่อน → หลัง',
  'Before': 'ก่อน',
  'After': 'หลัง',
  'Freed memory can be reused by the OS immediately; the system figure moves as other apps allocate.':
    'ระบบปฏิบัติการนำหน่วยความจำที่คืนมาไปใช้ได้ทันที ตัวเลขของระบบจะเปลี่ยนไปตามที่แอปอื่นจองใช้',
  'Closed — changed your mind?': 'ปิดแล้ว — เปลี่ยนใจไหม?',
  'Reopen': 'เปิดอีกครั้ง',
  'Nothing was closed.': 'ไม่มีแอปใดถูกปิด',
  'Still open (may be asking to save):': 'ยังเปิดอยู่ (อาจกำลังถามให้บันทึกงาน):',
  'Review again': 'ตรวจดูอีกครั้ง',
  'Smart cleanup, not blind cleanup': 'เคลียร์อย่างชาญฉลาด ไม่ใช่เคลียร์แบบไม่ดูอะไร',
  'Reading your apps…': 'กำลังอ่านข้อมูลแอป…',
  '{n} app you aren’t using': '{n} แอปที่คุณไม่ได้ใช้',
  '{n} apps you aren’t using': '{n} แอปที่คุณไม่ได้ใช้',
  'Learning which apps you use…': 'กำลังเรียนรู้ว่าคุณใช้แอปใดบ้าง…',
  'Nothing safe to close right now.': 'ตอนนี้ยังไม่มีแอปที่ควรปิด',
  'No cleanup necessary.': 'ไม่จำเป็นต้องเคลียร์',
  'Watching which apps you use ·': 'กำลังดูว่าคุณใช้แอปใดบ้าง ·',
  'of 20 min. Suggestions appear once MemNEX knows what you haven’t touched.':
    'จาก 20 นาที คำแนะนำจะแสดงเมื่อ MemNEX รู้ว่าแอปใดที่คุณไม่ได้แตะ',
  'Optional': 'ไม่บังคับ',
  'Idle apps you could close anyway': 'แอปที่ไม่ได้ใช้งานซึ่งจะปิดก็ได้',
  'Memory pressure is normal, so this isn’t needed. These apps haven’t been used for a while and aren’t doing background work.':
    'แรงกดดันหน่วยความจำปกติ จึงไม่จำเป็นต้องทำ แอปเหล่านี้ไม่ได้ถูกใช้มาสักพักและไม่ได้ทำงานเบื้องหลัง',
  'Growing memory': 'หน่วยความจำเพิ่มขึ้นเรื่อยๆ',
  'Restart to reclaim': 'รีสตาร์ทเพื่อคืนหน่วยความจำ',
  'These apps keep growing while you use them — often a leak. Restarting gives the memory back and reopens the app.':
    'แอปเหล่านี้ใช้หน่วยความจำเพิ่มขึ้นเรื่อยๆ ระหว่างที่คุณใช้ — มักเป็นอาการรั่ว การรีสตาร์ทจะคืนหน่วยความจำและเปิดแอปใหม่ให้',
  'Grew': 'เพิ่มขึ้น',
  'min · now': 'นาที · ตอนนี้',
  'Potential memory recovery': 'หน่วยความจำที่อาจได้คืน',
  'idle app': 'แอปที่ไม่ได้ใช้งาน',
  'Estimate. You can reopen anything MemNEX closes for the next hour.':
    'เป็นค่าประมาณ คุณเปิดแอปที่ MemNEX ปิดไปกลับมาได้ภายในหนึ่งชั่วโมง',
  'Never recommended for cleanup and can’t be quit from MemNEX. System processes are always protected.':
    'จะไม่ถูกแนะนำให้เคลียร์และปิดจาก MemNEX ไม่ได้ โปรเซสของระบบจะถูกป้องกันไว้เสมอ',
  'Unprotect {s}': 'เลิกป้องกัน {s}',
  'None yet. Use Protect on the Processes page.': 'ยังไม่มี ใช้ “ป้องกัน” ในหน้าโปรเซส',
  'Apps you usually keep open': 'แอปที่คุณมักเปิดไว้',
  'Learned from your choices: after you keep an idle app open 3 times, MemNEX stops suggesting it.':
    'เรียนรู้จากการเลือกของคุณ: เมื่อคุณเลือกเปิดแอปที่ไม่ได้ใช้งานไว้ 3 ครั้ง MemNEX จะเลิกแนะนำแอปนั้น',
  'Suggest {s} again': 'แนะนำ {s} อีกครั้ง',
  'Suggest again': 'แนะนำอีกครั้ง',
  'Nothing learned yet.': 'ยังไม่ได้เรียนรู้อะไร',
  'Local data': 'ข้อมูลในเครื่อง',
  'Metrics are read from this computer only. Nothing is sent to a cloud service.':
    'อ่านค่าจากคอมพิวเตอร์เครื่องนี้เท่านั้น ไม่มีการส่งข้อมูลใดไปยังบริการคลาวด์',
  'Quit application': 'ปิดแอปพลิเคชัน',
  'Quit': 'ปิดแอป',
  'MemNEX sends this process a normal stop signal (like Ctrl+C). About':
    'MemNEX จะส่งสัญญาณหยุดตามปกติให้โปรเซสนี้ (เหมือนกด Ctrl+C) ประมาณ',
  'would be released.': 'จะได้คืน',
  'MemNEX asks the app to close normally, like choosing Quit from its menu. It may ask you to save work. About':
    'MemNEX จะขอให้แอปปิดตามปกติ เหมือนเลือก Quit จากเมนูของแอป แอปอาจถามให้คุณบันทึกงาน ประมาณ',
  'Waiting for app…': 'กำลังรอแอป…',
  'Application did not close': 'แอปพลิเคชันไม่ได้ปิด',
  'is still running.': 'ยังทำงานอยู่',
  'It may be waiting for you to save, or it refused a normal quit.': 'แอปอาจกำลังรอให้คุณบันทึกงาน หรือปฏิเสธการปิดตามปกติ',
  'Check the app first. Force close ends it immediately and': 'ตรวจดูแอปก่อน การบังคับปิดจะหยุดแอปทันทีและ',
  'unsaved work will be lost': 'งานที่ยังไม่ได้บันทึกจะหายไป',
  'Force close': 'บังคับปิด',
  'This skips the app’s own quit routine.': 'วิธีนี้จะข้ามขั้นตอนการปิดของแอปเอง',
  'Unsaved work will be lost.': 'งานที่ยังไม่ได้บันทึกจะหายไป',
  'Try Quit first when you can.': 'ถ้าทำได้ ให้ลองปิดแอปตามปกติก่อน',
  'Restart application': 'รีสตาร์ทแอปพลิเคชัน',
  'MemNEX quits it normally (it may ask you to save) and opens it again.':
    'MemNEX จะปิดแอปตามปกติ (แอปอาจถามให้บันทึกงาน) แล้วเปิดขึ้นมาใหม่',
  'It grew': 'แอปใช้เพิ่มขึ้น',
  'Most apps restore their windows.': 'แอปส่วนใหญ่จะเปิดหน้าต่างเดิมกลับมาให้',
  'Confirm cleanup': 'ยืนยันการเคลียร์',
  'Each app is asked to quit normally. Apps that refuse stay open — MemNEX never force closes during cleanup.':
    'แต่ละแอปจะถูกขอให้ปิดตามปกติ แอปที่ปฏิเสธจะยังเปิดอยู่ — MemNEX ไม่บังคับปิดแอประหว่างการเคลียร์',
  'Closing…': 'กำลังปิด…',
  'Close and recover ~{n}': 'ปิดและคืนพื้นที่ ~{n}',
  'Grew {n} in {n} min': 'เพิ่มขึ้น {n} ใน {n} นาที',
  '↗ Growing': '↗ กำลังเพิ่มขึ้น',
  'Unprotect': 'เลิกป้องกัน',
  'Protect': 'ป้องกัน',
  'Choose': 'เลือก',
  'processes': 'โปรเซส',
  'User': 'ผู้ใช้',
  'more processes': 'โปรเซสเพิ่มเติม',
  'Not responding to Quit?': 'แอปไม่ตอบสนองต่อการปิด?',
  'Force close…': 'บังคับปิด…',

  /* ── Command palette ── */
  'Search files for “{s}”': 'ค้นหาไฟล์ “{s}”',
  'Command palette': 'แถบคำสั่ง',
  'Search apps, projects, ports, commands…': 'ค้นหาแอป โปรเจกต์ พอร์ต คำสั่ง…',
  'Search commands': 'ค้นหาคำสั่ง',
  'The Workbench service isn’t answering. Run': 'เซอร์วิสของ Workbench ไม่ตอบสนอง ให้รัน',
  ', then try again.': 'แล้วลองอีกครั้ง',
  'Loading commands…': 'กำลังโหลดคำสั่ง…',
  'No command matches “': 'ไม่มีคำสั่งที่ตรงกับ “',
  'to move': 'เพื่อเลื่อน',
  'to open': 'เพื่อเปิด',
  'to close': 'เพื่อปิด',

  /* ── Home ── */
  'NEX Workbench can’t reach its local service.': 'NEX Workbench เชื่อมต่อเซอร์วิสในเครื่องไม่ได้',
  'Run': 'รัน',
  'in the NEXWorkbench folder, then this page reconnects on its own.': 'ในโฟลเดอร์ NEXWorkbench แล้วหน้านี้จะเชื่อมต่อใหม่เอง',
  'Reading your machine…': 'กำลังอ่านข้อมูลเครื่อง…',
  'Home': 'หน้าหลัก',
  'Quick actions': 'การทำงานด่วน',
  'High-memory apps': 'แอปที่ใช้หน่วยความจำสูง',
  'Find a file': 'หาไฟล์',
  'Search everything': 'ค้นหาทุกอย่าง',
  'Workspace status': 'สถานะพื้นที่ทำงาน',
  'Modules': 'โมดูล',
  '{n} item needs review': '{n} รายการต้องตรวจดู',
  '{n} items need review': '{n} รายการต้องตรวจดู',
  'Nothing needs your attention': 'ไม่มีอะไรต้องดู',
  'Each module checks its own domain — memory pressure, port conflicts, crashed services, missing variables.':
    'แต่ละโมดูลตรวจสอบส่วนของตัวเอง — แรงกดดันหน่วยความจำ พอร์ตชนกัน เซอร์วิสที่ล่ม ตัวแปรที่ขาดหายไป',
  'more in the modules.': 'รายการเพิ่มเติมในโมดูล',
  'Pick up where you left off': 'ทำต่อจากที่ค้างไว้',
  'Nothing to resume yet': 'ยังไม่มีงานให้ทำต่อ',
  'Nothing to resume': 'ไม่มีงานให้ทำต่อ',
  'WorkNEX remembers work only in the apps you choose to track. Choose them in WorkNEX › Settings.':
    'WorkNEX จำงานเฉพาะในแอปที่คุณเลือกให้ติดตามเท่านั้น เลือกได้ที่ WorkNEX › ตั้งค่า',
  'Projects appear here while their dev servers run.': 'โปรเจกต์จะแสดงที่นี่ขณะที่ dev server กำลังทำงาน',
  'This session': 'เซสชันนี้',
  'Quiet so far': 'ยังไม่มีอะไรเกิดขึ้น',
  'Cleanups, service starts and stops, crashes and port conflicts show up here. Kept in memory only.':
    'การเคลียร์ การเริ่มและหยุดเซอร์วิส การล่ม และพอร์ตชนกันจะแสดงที่นี่ เก็บไว้ในหน่วยความจำเท่านั้น',
  'Choose apps': 'เลือกแอป',
  'Choose folders': 'เลือกโฟลเดอร์',

  /* ── Page header ── */
  'Breadcrumb': 'เส้นทางนำทาง',
  'Search and run commands': 'ค้นหาและเรียกใช้คำสั่ง',
  'WorkNEX is tracking only the apps you approved ({s}).': 'WorkNEX ติดตามเฉพาะแอปที่คุณอนุญาต ({s})',
  'WorkNEX ·': 'WorkNEX ·',
  'Runs on this computer only. Nothing is sent to a cloud service.':
    'ทำงานบนคอมพิวเตอร์เครื่องนี้เท่านั้น ไม่มีการส่งข้อมูลใดไปยังบริการคลาวด์',

  /* ── Workbench settings ── */
  'The Workbench service isn’t answering.': 'เซอร์วิสของ Workbench ไม่ตอบสนอง',
  'Loading settings…': 'กำลังโหลดการตั้งค่า…',
  'in the NEXWorkbench folder.': 'ในโฟลเดอร์ NEXWorkbench',
  'One theme for Home, MemNEX and DevNEX. Follow the system or choose a mode.':
    'ธีมเดียวสำหรับหน้าหลัก MemNEX และ DevNEX ใช้ตามระบบหรือเลือกโหมดเอง',
  'Refresh behavior': 'การรีเฟรช',
  'Normal: memory and CPU every 3 s, processes and projects every 5 s. Relaxed polls three times less often — lighter on battery.':
    'ปกติ: หน่วยความจำและ CPU ทุก 3 วินาที โปรเซสและโปรเจกต์ทุก 5 วินาที แบบประหยัดจะดึงข้อมูลน้อยลงสามเท่า — ประหยัดแบตเตอรี่กว่า',
  'Refreshing less often.': 'รีเฟรชน้อยลงแล้ว',
  'Normal refresh restored.': 'กลับมารีเฟรชตามปกติแล้ว',
  'Enabled modules': 'โมดูลที่เปิดใช้',
  'A turned-off module disappears from the sidebar, Home and Attention. Its data and settings are kept.':
    'โมดูลที่ปิดไว้จะไม่แสดงในแถบด้านข้าง หน้าหลัก และสิ่งที่ควรดู ข้อมูลและการตั้งค่ายังเก็บไว้เหมือนเดิม',
  'turned off': 'ปิดแล้ว',
  'turned on': 'เปิดแล้ว',
  'Module settings': 'ตั้งค่าโมดูล',
  'Protected apps, learned preferences, project folders and registered projects belong to each module.':
    'แอปที่ป้องกันไว้ ค่าที่เรียนรู้ โฟลเดอร์โปรเจกต์ และโปรเจกต์ที่ลงทะเบียนไว้ เป็นของแต่ละโมดูล',
  'MemNEX settings': 'ตั้งค่า MemNEX',
  'DevNEX settings': 'ตั้งค่า DevNEX',
  'Local data location': 'ตำแหน่งข้อมูลในเครื่อง',
  'Small JSON files on this computer. No database, no cloud sync. Delete a folder to reset that module.':
    'ไฟล์ JSON ขนาดเล็กบนคอมพิวเตอร์เครื่องนี้ ไม่มีฐานข้อมูล ไม่ซิงก์ขึ้นคลาวด์ ลบโฟลเดอร์เพื่อรีเซ็ตโมดูลนั้น',
  'The web app listens on 127.0.0.1:{n}; the API on 127.0.0.1:{n} is internal and only accepts requests from this app. Nothing is reachable from your network.':
    'เว็บแอปรับการเชื่อมต่อที่ 127.0.0.1:{n} ส่วน API ที่ 127.0.0.1:{n} ใช้ภายในและรับคำขอจากแอปนี้เท่านั้น ไม่มีอะไรเข้าถึงได้จากเครือข่ายของคุณ',
  'Localhost only': 'Localhost เท่านั้น',
  'Version {n}': 'เวอร์ชัน {n}',
  'No telemetry · no account': 'ไม่เก็บข้อมูลการใช้งาน · ไม่ต้องมีบัญชี',

  /* ── Shell ── */
  'Local-first': 'เน้นทำงานในเครื่อง',
  'Main': 'หลัก',
  'Tools': 'เครื่องมือ',

  /* ── Shared UI kit ── */
  'Process no longer exists. It may have already closed.': 'ไม่พบโปรเซสนี้แล้ว อาจปิดไปแล้ว',
  'Confirmation required before {s} can act.': 'ต้องยืนยันก่อน {s} จึงจะดำเนินการได้',
  'Unsupported operation (HTTP {s}).': 'ไม่รองรับการทำงานนี้ (HTTP {s})',
  'Lost connection to {s}’s local service. If it was started from an app that just closed, run npm run dev again.':
    'ขาดการเชื่อมต่อกับเซอร์วิสในเครื่องของ {s} ถ้าเริ่มจากแอปที่เพิ่งปิดไป ให้รัน npm run dev อีกครั้ง',
  'just now': 'เมื่อสักครู่',
  '{s}s ago': '{s} วินาทีที่แล้ว',
  '{n} min ago': '{n} นาทีที่แล้ว',
  '{n} h ago': '{n} ชม. ที่แล้ว',
  '{n} d ago': '{n} วันที่แล้ว',
  'Service unreachable — retrying': 'เชื่อมต่อเซอร์วิสไม่ได้ — กำลังลองใหม่',
  'Live · updated {n}': 'สด · อัปเดต {n}',
  'Live · updated just now': 'สด · อัปเดตเมื่อสักครู่',
  'Connecting…': 'กำลังเชื่อมต่อ…',
  'Refresh': 'รีเฟรช',

  /* ── MemNEX engine: cleanup ── */
  'These apps haven’t been used for a while and are idle in the background. Nothing is closed until you confirm.':
    'แอปเหล่านี้ไม่ได้ถูกใช้มาสักพักและค้างอยู่เบื้องหลัง จะไม่มีแอปใดถูกปิดจนกว่าคุณจะยืนยัน',
  'No cleanup necessary — memory pressure is normal.': 'ไม่จำเป็นต้องเคลียร์ — แรงกดดันหน่วยความจำปกติ',
  'MemNEX has watched app usage for {s} min. Inactive-app suggestions need about 20 min of observation.':
    'MemNEX ดูการใช้งานแอปมาแล้ว {s} นาที คำแนะนำเรื่องแอปที่ไม่ได้ใช้ต้องสังเกตประมาณ 20 นาที',
  'The apps using the most memory ({s}) are in use, so MemNEX won’t suggest closing them.':
    'แอปที่ใช้หน่วยความจำมากที่สุด ({s}) กำลังถูกใช้งานอยู่ MemNEX จึงจะไม่แนะนำให้ปิด',
  'No inactive app is using enough memory to be worth closing.': 'ไม่มีแอปที่ไม่ได้ใช้งานตัวไหนใช้หน่วยความจำมากพอที่จะคุ้มกับการปิด',

  /* ── MemNEX engine ── */
  'Windows system services': 'เซอร์วิสระบบของ Windows',
  'macOS system services': 'เซอร์วิสระบบของ macOS',
  'Unsupported operation.': 'ไม่รองรับการทำงานนี้',
  'Restart is only available for applications.': 'รีสตาร์ทได้เฉพาะแอปพลิเคชันเท่านั้น',
  'Application did not close, so it was not restarted. It may be waiting for you to save.':
    'แอปพลิเคชันไม่ได้ปิด จึงไม่ได้รีสตาร์ท แอปอาจกำลังรอให้คุณบันทึกงาน',
  'Application did not close. It may be waiting for you to save, or it refused a normal quit.':
    'แอปพลิเคชันไม่ได้ปิด แอปอาจกำลังรอให้คุณบันทึกงาน หรือปฏิเสธการปิดตามปกติ',
  'MemNEX can only reopen apps it closed in the last hour.': 'MemNEX เปิดอีกครั้งได้เฉพาะแอปที่ปิดไปภายในหนึ่งชั่วโมงที่ผ่านมา',
  'None of the selected applications can be closed.': 'ไม่มีแอปพลิเคชันที่เลือกไว้ตัวใดปิดได้',

  /* ── MemNEX engine: memory health ── */
  'macOS reports critical memory pressure. Closing an idle app will help immediately.':
    'macOS รายงานว่าแรงกดดันหน่วยความจำอยู่ในระดับวิกฤต การปิดแอปที่ไม่ได้ใช้งานจะช่วยได้ทันที',
  'The system is actively moving memory to disk. Closing an app you are not using will improve responsiveness.':
    'ระบบกำลังย้ายหน่วยความจำไปไว้บนดิสก์ การปิดแอปที่คุณไม่ได้ใช้จะช่วยให้ระบบตอบสนองดีขึ้น',
  'macOS reports elevated memory pressure. Closing an app you are not using may improve responsiveness.':
    'macOS รายงานว่าแรงกดดันหน่วยความจำสูงขึ้น การปิดแอปที่คุณไม่ได้ใช้อาจช่วยให้ระบบตอบสนองดีขึ้น',
  'Memory is well used, but macOS reports normal pressure. No action needed.':
    'มีการใช้หน่วยความจำค่อนข้างมาก แต่ macOS รายงานว่าแรงกดดันปกติ ไม่ต้องทำอะไร',
  'Memory pressure is normal. Your system is running comfortably.': 'แรงกดดันหน่วยความจำปกติ ระบบทำงานได้สบาย',
  'Almost no memory is available and the system is paging to disk.': 'หน่วยความจำแทบไม่เหลือ และระบบกำลังสลับหน้าหน่วยความจำไปที่ดิสก์',
  'The system is actively paging to disk. Closing an idle app will improve responsiveness.':
    'ระบบกำลังสลับหน้าหน่วยความจำไปที่ดิสก์ การปิดแอปที่ไม่ได้ใช้งานจะช่วยให้ระบบตอบสนองดีขึ้น',
  'Available memory is low. Closing an idle app may improve responsiveness.':
    'หน่วยความจำที่ว่างเหลือน้อย การปิดแอปที่ไม่ได้ใช้งานอาจช่วยให้ระบบตอบสนองดีขึ้น',
  'Memory is well used, but there is headroom. No action needed.': 'มีการใช้หน่วยความจำค่อนข้างมาก แต่ยังเหลือพอ ไม่ต้องทำอะไร',
  'Plenty of memory is available. Your system is running comfortably.': 'หน่วยความจำว่างเหลือเฟือ ระบบทำงานได้สบาย',

  /* ── MemNEX module (commands) ── */
  'Local System Intelligence': 'ข้อมูลเชิงลึกของระบบในเครื่อง',
  'Idle apps': 'แอปที่ไม่ได้ใช้งาน',
  'Open MemNEX': 'เปิด MemNEX',
  'Show running apps': 'แสดงแอปที่กำลังทำงาน',
  'Show high-memory apps': 'แสดงแอปที่ใช้หน่วยความจำสูง',

  /* ── MemNEX engine: protection ── */
  'System Critical': 'สำคัญต่อระบบ',
  'Part of the operating system.': 'เป็นส่วนหนึ่งของระบบปฏิบัติการ',
  'NEX Workbench itself.': 'ตัว NEX Workbench เอง',
  'MemNEX is running inside this app — closing it would stop MemNEX.': 'MemNEX ทำงานอยู่ในแอปนี้ — การปิดแอปจะทำให้ MemNEX หยุดทำงาน',
  'Protected by your preference.': 'ป้องกันไว้ตามที่คุณตั้งค่า',
  'System protected. {s}: {s}': 'ระบบป้องกันไว้ {s}: {s}',
  'part of the operating system': 'เป็นส่วนหนึ่งของระบบปฏิบัติการ',
  '{s} is protected by your preference. Unprotect it first.': '{s} ถูกป้องกันไว้ตามที่คุณตั้งค่า ให้เลิกป้องกันก่อน',

  /* ── MemNEX engine: recommendations / diagnosis ── */
  'Restart {s}': 'รีสตาร์ท {s}',
  'Close {s}': 'ปิด {s}',
  ', mostly in {s}': ' ส่วนใหญ่อยู่ใน {s}',
  'and macOS is moving memory to disk': 'และ macOS กำลังย้ายหน่วยความจำไปไว้บนดิสก์',
  '{s} has grown {n} in {n} minutes.': '{s} ใช้หน่วยความจำเพิ่มขึ้น {n} ใน {n} นาที',
  '{s} has grown {n} in {n} minutes{s}.': '{s} ใช้หน่วยความจำเพิ่มขึ้น {n} ใน {n} นาที{s}',
  'That steady growth is the main reason memory is tight. Restarting it usually gives the memory back.':
    'การเพิ่มขึ้นต่อเนื่องนี้คือสาเหตุหลักที่หน่วยความจำตึงตัว การรีสตาร์ทมักจะคืนหน่วยความจำกลับมา',
  'That steady growth is the main reason memory is tight{s}. Restarting it usually gives the memory back.':
    'การเพิ่มขึ้นต่อเนื่องนี้คือสาเหตุหลักที่หน่วยความจำตึงตัว{s} การรีสตาร์ทมักจะคืนหน่วยความจำกลับมา',
  'Memory is tight. {s} is holding {n} while you aren’t using it.':
    'หน่วยความจำตึงตัว {s} ใช้อยู่ {n} ทั้งที่คุณไม่ได้ใช้งาน',
  'Memory is tight. {s} and {s} are holding {n} while you aren’t using them.':
    'หน่วยความจำตึงตัว {s} และ {s} ใช้อยู่ {n} ทั้งที่คุณไม่ได้ใช้งาน',
  'Memory is tight and macOS is moving memory to disk. {s} is holding {n} while you aren’t using it.':
    'หน่วยความจำตึงตัวและ macOS กำลังย้ายหน่วยความจำไปไว้บนดิสก์ {s} ใช้อยู่ {n} ทั้งที่คุณไม่ได้ใช้งาน',
  'Memory is tight and macOS is moving memory to disk. {s} and {s} are holding {n} while you aren’t using them.':
    'หน่วยความจำตึงตัวและ macOS กำลังย้ายหน่วยความจำไปไว้บนดิสก์ {s} และ {s} ใช้อยู่ {n} ทั้งที่คุณไม่ได้ใช้งาน',
  'Closing idle apps is the fastest way to make the system responsive again.':
    'การปิดแอปที่ไม่ได้ใช้งานคือวิธีที่เร็วที่สุดที่จะทำให้ระบบกลับมาตอบสนองได้ดี',
  'Memory is tight, mostly from apps you’re using.': 'หน่วยความจำตึงตัว ส่วนใหญ่มาจากแอปที่คุณกำลังใช้',
  'Memory is tight, mostly from apps you’re using ({s}).': 'หน่วยความจำตึงตัว ส่วนใหญ่มาจากแอปที่คุณกำลังใช้ ({s})',
  'Memory is tight and macOS is moving memory to disk, mostly from apps you’re using.':
    'หน่วยความจำตึงตัวและ macOS กำลังย้ายหน่วยความจำไปไว้บนดิสก์ ส่วนใหญ่มาจากแอปที่คุณกำลังใช้',
  'Memory is tight and macOS is moving memory to disk, mostly from apps you’re using ({s}).':
    'หน่วยความจำตึงตัวและ macOS กำลังย้ายหน่วยความจำไปไว้บนดิสก์ ส่วนใหญ่มาจากแอปที่คุณกำลังใช้ ({s})',
  'MemNEX is still learning which apps you use; idle-app suggestions appear after about 20 minutes.':
    'MemNEX ยังเรียนรู้อยู่ว่าคุณใช้แอปใดบ้าง คำแนะนำเรื่องแอปที่ไม่ได้ใช้งานจะแสดงหลังจากประมาณ 20 นาที',
  'Nothing is idle enough to close safely. If this happens often, this workload needs more memory than the machine has.':
    'ไม่มีแอปที่ว่างนานพอจะปิดได้โดยไม่กระทบงาน ถ้าเกิดขึ้นบ่อย แสดงว่างานนี้ต้องใช้หน่วยความจำมากกว่าที่เครื่องมี',
  'See all apps': 'ดูแอปทั้งหมด',
  'macOS is slowing the CPU down to keep the Mac cool.': 'macOS กำลังลดความเร็ว CPU เพื่อไม่ให้ Mac ร้อนเกินไป',
  'kernel_task reserves CPU time when the machine is hot. Improve airflow or close heavy apps; this isn’t a memory problem.':
    'kernel_task จะกันเวลา CPU ไว้เมื่อเครื่องร้อน ช่วยให้อากาศถ่ายเทดีขึ้นหรือปิดแอปที่หนัก ปัญหานี้ไม่ได้เกิดจากหน่วยความจำ',
  'Spotlight is indexing your files.': 'Spotlight กำลังทำดัชนีไฟล์ของคุณ',
  'This is temporary — common after updates or copying many files — and settles on its own.':
    'เป็นเพียงชั่วคราว — มักเกิดหลังอัปเดตหรือคัดลอกไฟล์จำนวนมาก — และจะกลับเป็นปกติเอง',
  '{s} is keeping the processor busy.': '{s} กำลังใช้โปรเซสเซอร์หนัก',
  'It’s the app you’re using, so this is probably expected work.': 'เป็นแอปที่คุณกำลังใช้ จึงน่าจะเป็นการทำงานตามปกติ',
  'It’s working in the background.': 'แอปกำลังทำงานอยู่เบื้องหลัง',
  'All good for now, but {s} keeps growing (+{n} in {n} min).': 'ตอนนี้ยังปกติดี แต่ {s} ใช้หน่วยความจำเพิ่มขึ้นเรื่อยๆ (+{n} ใน {n} นาที)',
  'If it continues, it will start to slow things down.': 'ถ้ายังเป็นแบบนี้ต่อไป เครื่องจะเริ่มช้าลง',
  'If it continues, it will start to slow things down{s}.': 'ถ้ายังเป็นแบบนี้ต่อไป เครื่องจะเริ่มช้าลง{s}',
  'Everything is running smoothly.': 'ทุกอย่างทำงานราบรื่น',
  'No action needed. {s} hasn’t been used for a while, if you want to tidy up.':
    'ไม่ต้องทำอะไร {s} ไม่ได้ถูกใช้มาสักพัก หากต้องการจัดระเบียบ',
  'No action needed. {s} and {s} haven’t been used for a while, if you want to tidy up.':
    'ไม่ต้องทำอะไร {s} และ {s} ไม่ได้ถูกใช้มาสักพัก หากต้องการจัดระเบียบ',
  'No action needed.': 'ไม่ต้องทำอะไร',
  '{n} min': '{n} นาที',
  '{n} h': '{n} ชม.',
  '{n} day': '{n} วัน',
  '{n} days': '{n} วัน',
  'Core operating system services. MemNEX never controls these.': 'เซอร์วิสหลักของระบบปฏิบัติการ MemNEX ไม่ควบคุมส่วนนี้',
  'NEX Workbench’s own API and web servers.': 'API และเว็บเซิร์ฟเวอร์ของ NEX Workbench เอง',

  /* ── API: activity feed ── */
  'Smart Cleanup closed {n} app': 'เคลียร์อัจฉริยะปิดไป {n} แอป',
  'Smart Cleanup closed {n} apps': 'เคลียร์อัจฉริยะปิดไป {n} แอป',
  'Memory pressure high': 'แรงกดดันหน่วยความจำสูง',
  'Memory pressure critical': 'แรงกดดันหน่วยความจำวิกฤต',
  'Memory pressure {s}': 'แรงกดดันหน่วยความจำ: {s}',
  '{s} closed': 'ปิด {s} แล้ว',
  'Started {s}': 'เริ่ม {s} แล้ว',
  'Stopped {s}': 'หยุด {s} แล้ว',
  '{s} failed': '{s} ล้มเหลว',
  '{s} failed{s}': '{s} ล้มเหลว{s}',
  '(exit {s})': '(exit {s})',
  'Port {n} conflict for {s}': 'พอร์ต {n} ชนกันสำหรับ {s}',
  'a project': 'โปรเจกต์หนึ่ง',
  'Stopped {s} (PID {n})': 'หยุด {s} แล้ว (PID {n})',
  'Started {s} context': 'เริ่มบริบทงาน {s} แล้ว',
  'Saved {s} context': 'บันทึกบริบทงาน {s} แล้ว',
  'Resumed {s}': 'ทำต่อ {s} แล้ว',
  'WorkNEX resumed': 'WorkNEX กลับมาทำงานต่อแล้ว',
  'FileNEX now indexes “{s}”': 'FileNEX เริ่มทำดัชนี “{s}” แล้ว',
  'FileNEX stopped indexing “{s}”': 'FileNEX หยุดทำดัชนี “{s}” แล้ว',
  'FileNEX stopped indexing “{s}” (index deleted)': 'FileNEX หยุดทำดัชนี “{s}” แล้ว (ลบดัชนีแล้ว)',
  '(index deleted)': '(ลบดัชนีแล้ว)',
  'FileNEX indexed “{s}” ({n} files)': 'FileNEX ทำดัชนี “{s}” แล้ว ({n} ไฟล์)',
  'FileNEX indexing paused': 'FileNEX หยุดทำดัชนีชั่วคราว',
  'FileNEX indexing resumed': 'FileNEX ทำดัชนีต่อแล้ว',
  'WorkNEX now tracks {s}': 'WorkNEX เริ่มติดตาม {s} แล้ว',
  'WorkNEX stopped tracking {s}': 'WorkNEX หยุดติดตาม {s} แล้ว',
  'WorkNEX stopped tracking {s} (history deleted)': 'WorkNEX หยุดติดตาม {s} แล้ว (ลบประวัติแล้ว)',
  '(history deleted)': '(ลบประวัติแล้ว)',

  /* ── API: request errors ── */
  'Query is too long.': 'คำค้นหายาวเกินไป',
  'Unknown file type.': 'ไม่รู้จักประเภทไฟล์นี้',
  'fileId is required.': 'ต้องระบุ fileId',
  'Choose whether to keep or delete this folder’s FileNEX index (deleteIndex=true|false).':
    'เลือกว่าจะเก็บหรือลบดัชนี FileNEX ของโฟลเดอร์นี้ (deleteIndex=true|false)',
  'min is a size in MB.': 'min ต้องเป็นขนาดในหน่วย MB',
  'Unknown sort.': 'ไม่รู้จักการเรียงลำดับนี้',
  'days is 7 or 30.': 'days ต้องเป็น 7 หรือ 30',
  'Unknown risk.': 'ไม่รู้จักระดับความเสี่ยงนี้',
  'Too many ids.': 'จำนวน id มากเกินไป',
  'appId is required.': 'ต้องระบุ appId',
  'appIds must be a list of application ids.': 'appIds ต้องเป็นรายการ id ของแอปพลิเคชัน',
  'No icon for this application': 'ไม่มีไอคอนสำหรับแอปพลิเคชันนี้',
  'app is required.': 'ต้องระบุ app',
  'disabledModules must be a list of module ids.': 'disabledModules ต้องเป็นรายการ id ของโมดูล',
  'refresh must be "normal" or "relaxed".': 'refresh ต้องเป็น "normal" หรือ "relaxed"',

  /* ── API: workbench status ── */
  'did not answer within {n}s': 'ไม่ตอบสนองภายใน {n} วินาที',
  '{s} status unavailable': 'ไม่มีสถานะของ {s}',
  '{s} is not answering': '{s} ไม่ตอบสนอง',
  'The Workbench could not read {s}: {s}. Other modules keep working.': 'Workbench อ่านข้อมูล {s} ไม่ได้: {s} โมดูลอื่นยังทำงานตามปกติ',
  'Everything is running normally.': 'ทุกอย่างทำงานตามปกติ',
  '{n} critical item needs attention now.': '{n} รายการวิกฤตต้องดูตอนนี้',
  '{n} critical items need attention now.': '{n} รายการวิกฤตต้องดูตอนนี้',
  '{n} item needs review.': '{n} รายการต้องตรวจดู',
  '{n} items need review.': '{n} รายการต้องตรวจดู',
  'Go to Home': 'ไปที่หน้าหลัก',
};
