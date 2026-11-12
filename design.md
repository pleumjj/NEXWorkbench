# MemNEX — Design

เอกสารนี้อธิบายการออกแบบที่ **ใช้อยู่จริงในโค้ด** ของ MemNEX: แนวคิด, design tokens, components, หน้าจอ, พฤติกรรมการทำงาน และกฎของ "intelligence" ที่อยู่เบื้องหลังคำแนะนำ
อ่านคู่กับ PRD (หลักการของ product) — ถ้าเอกสารนี้กับโค้ดไม่ตรงกัน ให้ถือโค้ดเป็นหลักแล้วแก้เอกสาร

ไฟล์หลัก

| ส่วน | ไฟล์ |
|---|---|
| Tokens และ styles ทั้งหมด (design system ของทั้ง NEX Workbench) | `packages/ui/src/styles.css` |
| Components ที่ใช้ร่วมกัน | `packages/ui/src/` |
| หน้าจอ MemNEX | `apps/workbench-web/modules/memnex/MemnexApp.tsx` |
| Shell (sidebar, top bar, command palette, Home) | `apps/workbench-web/shell/` |
| Font (bundled, offline) | `apps/workbench-web/app/layout.tsx` |
| Health engine + thresholds | `modules/memnex/src/memory-engine/health.ts` |
| การจัดกลุ่มแอป, สถานะ, คำแนะนำ | `packages/process-core/src/group.ts`, `modules/memnex/src/recommendation-engine/recommend.ts` |
| Diagnosis (ประโยคสรุปสาเหตุ) | `modules/memnex/src/recommendation-engine/diagnosis.ts` |
| คำอธิบายชื่อ process | `packages/process-core/src/dictionary.ts` |
| การติดตามการใช้งาน + memory growth | `modules/memnex/src/recommendation-engine/activity.ts`, `modules/memnex/src/memory-engine/growth.ts` |

> NEX Workbench: MemNEX ถูกย้ายเข้า shell กลางที่ `http://localhost:3900/memnex` โดยไม่เปลี่ยนหน้าตา — design system นี้เป็นต้นแบบของทุก module (DevNEX ใช้ tokens/components ชุดเดียวกัน) ดู `docs/architecture/ARCHITECTURE.md`

---

## 1. แนวคิด

**Quiet System Intelligence, bento edition**

โครงสร้างได้แรงบันดาลใจจาก bento layout (การ์ดหลายขนาดเรียงในกริด, พื้นครีม, ตัวอักษร navy, ตัวเลขใหญ่) แต่ปรับให้เข้ากับหลักของ PRD:

- **สี = ความหมาย** สีสดทั้ง 4 สีคือสถานะของระบบ ไม่ใช่การตกแต่ง ถ้าเห็นบล็อกสี แปลว่าระบบกำลังบอกอะไรบางอย่าง
- **Explain first. Act second.** ทุกคำแนะนำต้องมีเหตุผลและหลักฐานที่ผู้ใช้เห็นได้
- **เงียบเมื่อไม่มีอะไรต้องทำ** เครื่องปกติ = ไม่มีปุ่มชวนให้ทำอะไร
- **ไม่โกหกด้วยตัวเลข** ไม่ใช้ score ที่ไม่มีความหมาย, ไม่ใช้คำว่า Boost/Optimize, บอก "at least" เมื่อข้อมูลเป็นแค่ขอบล่าง

---

## 2. Design tokens

### 2.1 สีพื้นฐาน

| Token | Light | Dark | ใช้กับ |
|---|---|---|---|
| `--bg` | `#f3ede6` | `#07080c` | พื้นหลังหน้า |
| `--tile` | `#fbf8f4` | `#11131b` | การ์ด, ตาราง, modal |
| `--tile-2` | `#ece4da` | `#191c27` | พื้นรอง: หัวตาราง, track ของ bar, icon tile |
| `--ink` | `#0b1633` | `#f3ede6` | ตัวอักษรหลัก, ปุ่มหลัก |
| `--ink-inverse` | `#fbf8f4` | `#0b1633` | ตัวอักษรบน `--ink` |
| `--muted` | `#5b6275` | `#9aa1b4` | ตัวอักษรรอง, label |
| `--line` | `#e1d7cb` | `#232736` | เส้นแบ่ง, ขอบการ์ด |
| `--line-strong` | `#cfc3b5` | `#323748` | ขอบปุ่ม/chip/input |

### 2.2 สีสถานะ (เหมือนกันทั้ง light และ dark)

| Token | Hex | สถานะ | ตัวอักษรบนสีนี้ |
|---|---|---|---|
| `--healthy` | `#2a93c4` | Healthy | `--on-state` (navy) |
| `--moderate` | `#f5c518` | Moderate, memory กำลังโต | `--on-state` |
| `--high` | `#ff5a1f` | High, Review, ยอด recovery | `--on-state` |
| `--critical` | `#e2230f` | Critical, Force close, error | ขาว `#fff` |
| `--protected` | `#0b1633` (dark: `#c9d3ee`) | Protected | `--ink-inverse` |

**กฎ**
- ห้ามใช้สีสถานะเพื่อตกแต่ง ถ้าองค์ประกอบไม่ได้สื่อสถานะ ให้ใช้ `--tile`, `--ink`, `--muted`
- สีสถานะเป็น "signal" จึงไม่เปลี่ยนตาม theme
- ข้อยกเว้นเดียว: wordmark (บล็อกส้ม "MEM / NEX") เป็น identity ของแอป

### 2.3 Typography

- Font: **Schibsted Grotesk** ไฟล์ woff2 อยู่ใน repo ผ่าน `next/font/local` (ไม่มี request ออกนอกเครื่องเลย แม้ตอน build) fallback เป็น system UI
- Mono: `ui-monospace, SF Mono, Menlo, Consolas` ใช้กับ command line ของ process เท่านั้น
- ตัวเลขในตาราง/รายการ: `.num` = `tabular-nums` (ตัวเลขไม่กระโดดเวลาอัปเดต)
- ตัวเลขใหญ่ (`.big-num`, `.mid-num`): `proportional-nums` + `nowrap` เพราะ tabular ทำให้ตัวเลขใหญ่ห่างผิดรูป

| Class | ขนาด | ใช้กับ |
|---|---|---|
| `.state-word` | clamp(44px, 5vw, 72px), 700 | คำสถานะใน Diagnosis tile |
| `.big-num` | clamp(44px, 5vw, 64px), 700, −0.04em | ตัวเลขหลัก (Memory, Recovery) |
| `.topbar h1` | 32px, 700 | ชื่อหน้า |
| `.h2` | 26px, 700 | หัวข้อในหน้า |
| `.mid-num` | clamp(22px, 2.2vw, 28px), 700 | ตัวเลขใน stat tile |
| `.insight-headline` | 19px, 700 | ประโยค diagnosis |
| body | 14px / 1.5 | ทั่วไป |
| `.eyebrow`, `.fine` | 12px | label, หมายเหตุ — **ไม่ใช้ตัวอักษรเล็กกว่า 12px** |

### 2.4 รูปทรงและระยะ

- Radius: `--radius: 16px` (การ์ด, ตาราง), `--radius-sm: 10px` (nav item, icon), `999px` (ปุ่ม, chip, pill), modal `20px`
- Card: ขอบ 1px `--line`, **ไม่มีเงา**; การ์ดสถานะไม่มีขอบ (สีพื้นทำหน้าที่แทน)
- Gap ของ bento: 12px; padding การ์ด: 22px; spacing อิง 4/8px
- Icons: เส้น 1.75px บนกริด 24px, `stroke="currentColor"`, ขนาด 13–18px

---

## 3. Layout

- **Shell:** sidebar 220px (sticky) + content สูงสุด 1360px, padding `clamp(16px, 4vw, 48px)`
- **Bento:** กริด 12 คอลัมน์

| Tile | Desktop | ≤ 1180px | ≤ 560px |
|---|---|---|---|
| Diagnosis (health) | 6 คอลัมน์ × 2 แถว | 12 | 12 |
| Memory in use | 6 | 12 | 12 |
| Stat (Available / Swap / CPU) | 2 ต่อใบ | 4 ต่อใบ | 12 |
| Top memory consumers | 8 | 12 | 12 |
| This machine | 4 | 12 | 12 |

- **≤ 900px:** sidebar กลายเป็นแถบบน แสดง label เฉพาะหน้าที่เลือก, ตารางเปลี่ยนเป็น 2 แถวต่อแอป, Smart Cleanup เรียงเป็นคอลัมน์เดียว
- ต้องไม่มี horizontal scroll ที่ความกว้าง 390px

---

## 4. Components

### Tiles
- `.tile` การ์ดพื้นฐาน
- `.tile-health` **Diagnosis tile** — พื้นเป็นสีสถานะ (`.tone-healthy|moderate|high|critical`), แสดง: eyebrow → คำสถานะ → ประโยคสาเหตุ → รายละเอียด → evidence chips → ปุ่ม action (สูงสุด 2 + ลิงก์ไป Smart Cleanup)
- `.tile-stat` ตัวเลขเดี่ยว; `.is-warn` = ขอบซ้ายสีส้ม (ใช้เมื่อ swap กำลังโต)
- `.tile-recovery` ยอด memory ที่จะได้คืน — สีส้มเมื่อเป็นคำแนะนำจริง, `.is-optional` = พื้นปกติเมื่อเป็นแค่ทางเลือก

### Meter และ bar
- `.meter` แถบ memory สูง 12px สีตามสถานะ มีขีดแบ่งที่ **70% และ 85%** (threshold ของ Moderate/High)
- `.bar` / `.rank-bar` แถบเปรียบเทียบขนาด สี `--ink` เท่านั้น (ไม่ใช่สถานะ)

### Signals
`.signals` แสดงสัญญาณที่ใช้ตัดสิน health: จุดสี `ok` = azure, `warn` = yellow, `bad` = red ทุกค่าที่ระบบใช้ตัดสินต้องแสดงที่นี่

### Buttons

| Class | ใช้เมื่อ |
|---|---|
| `.btn-ink` | action หลักของบริบท (Quit, Close N apps, action แรกของ diagnosis) |
| `.btn-line` | action รอง (Protect, Restart, Stop) |
| `.btn-ghost` | navigation, Cancel, Refresh |
| `.btn-on-tone` | action รองบนพื้นสีสถานะ |
| `.btn-danger` | Force close เท่านั้น |
| `.btn-text-danger` | ลิงก์ "Force close…" ที่ซ่อนในแถวที่ขยาย |

**Force close ไม่ใช่ปุ่มระดับแรกเด็ดขาด** — เข้าถึงได้แค่ (1) หลัง Quit ไม่สำเร็จ หรือ (2) ในแถวที่ขยายแล้ว และต้องยืนยันเสมอ

### Status pills
| Pill | สี | ความหมาย |
|---|---|---|
| Review | ส้ม | แนะนำให้ปิด (ไม่ได้ใช้ + มี memory pressure) |
| Protected | navy + ไอคอนกุญแจ | ผู้ใช้ห้ามปิด |
| System | ขอบเทา + กุญแจ | OS, MemNEX เอง, หรือแอปที่ MemNEX รันอยู่ข้างใน |
| ↗ Growing | เหลือง | memory โตต่อเนื่อง |
| Normal | **ไม่แสดง** | ลด noise |

### App icon
- ใช้ **ไอคอนจริงของแอปจาก OS** (`GET /api/system/icon/:pid`)
- ถ้าไม่มีไอคอน ใช้ glyph บอก *ประเภท*: โล่ = system, terminal = command-line, หน้าต่าง = แอปทั่วไป
- **ห้ามใช้ตัวอักษรย่อ (monogram)** เช่น "V", "C" — ผู้ใช้ปฏิเสธเพราะอ่านไม่ออก

### Table rows (`AppRow`)
คอลัมน์: แอป (ไอคอน, ชื่อ, จำนวน process · เหตุผลแรก, คำอธิบาย) → สถานะ → CPU (% ของทั้งเครื่อง) → Memory (ตัวเลข + bar) → actions
กดแถวเพื่อขยายดู PID / process / CPU / memory / user และคำอธิบายจาก dictionary

### Modal และ toast
- Modal: หัว eyebrow บอกประเภท action, ชื่อแอป, ผลที่จะเกิด (memory ที่จะได้คืน, งานที่อาจหาย), Cancel ซ้าย / action ขวา
- Toast: 5 วินาที; ถ้ามีปุ่ม **Reopen** อยู่ 12 วินาที; error ใช้พื้นแดง

---

## 5. หน้าจอ

### Overview (หน้าแรก)
ตอบคำถาม "เครื่องฉันโอเคไหม" ใน 1 วินาที
Diagnosis tile → Memory in use + signals → Available / Swap / CPU → Top 5 consumers (จัดกลุ่มตามแอป) → This machine

### Processes
- Search, filter chips (All / High memory ≥ 1 GB / Recommended / Protected / System) พร้อมจำนวน, Sort (Memory / CPU / Name / Processes)
- แอปที่ใช้น้อยกว่า 50 MB ยุบไว้ใต้ "Show N smaller apps"
- **Command-line & background** แยกเป็น section ของตัวเอง: dev server, node, npm, postgres ฯลฯ ไม่มีปุ่ม Quit ระดับกลุ่ม — Stop ได้ทีละ process

### Smart Cleanup
- **แนะนำแอปที่ไม่ได้ใช้งาน ไม่ใช่แอปที่ใหญ่ที่สุด**
- ภายใต้ memory pressure: รายการถูกติ๊กไว้ให้
- pressure ปกติ: "No cleanup necessary" + section **Optional** ที่ไม่ติ๊กไว้
- ช่วงเรียนรู้ (< 20 นาที): แสดง progress แทนคำแนะนำ
- section **Restart to reclaim** สำหรับแอปที่ memory โต
- ผลลัพธ์: memory ที่แอปคืน, system before → after, รายชื่อที่ปิด + ปุ่ม Reopen, แอปที่ยังไม่ปิด/ล้มเหลวพร้อมเหตุผล

### Settings
Appearance (System / Light / Dark — จำใน localStorage), Protected applications, Apps you usually keep open (+ Suggest again), Local data

---

## 6. พฤติกรรมการทำงาน (safety)

| Action | วิธีที่ทำ | หลังจากนั้น |
|---|---|---|
| **Quit** (แอป GUI) | ขอให้ทั้งแอปปิดแบบปกติ — macOS: AppleScript `quit` ผ่าน bundle id, Windows: `CloseMainWindow` | รอสูงสุด 5 วินาที → ถ้ายังอยู่แสดง "Application did not close" + Force close / Cancel |
| **Stop** (command-line) | SIGTERM / `taskkill` ทีละ PID | — |
| **Force close** | ยุติทุก process ของแอปทันที | ต้องยืนยันเสมอ, ไม่เกิดอัตโนมัติ |
| **Restart** | Quit แบบปกติ → ถ้าปิดจริงค่อยเปิดใหม่ | ถ้าแอปไม่ยอมปิด จะไม่เปิดซ้ำ |
| **Cleanup** | Quit แบบปกติทุกแอปที่เลือก, **ไม่ Force close** | แสดงผลจริง ไม่ใช่ค่าประมาณ |
| **Reopen** | เฉพาะแอปที่ MemNEX ปิดเองภายใน **1 ชั่วโมง** | API ปฏิเสธแอปอื่น |

**สิ่งที่ API ปฏิเสธเสมอ (ไม่ใช่แค่ซ่อนปุ่ม)**
- System Critical: path ของ OS, ชื่อ process หลักของ OS, process ของ root / `_service` accounts
- MemNEX เอง (process ที่อยู่ใต้ repo)
- **แอปที่ MemNEX รันอยู่ข้างใน** — ไล่ parent pid จาก API ขึ้นไป; การปิดแอปนี้เคยทำให้ MemNEX ดับ ("Failed to fetch")
- แอปที่ผู้ใช้ Protect
- คำขอที่ไม่มี `confirmed: true`

แอปของ Apple ที่ผู้ใช้เปิดเอง (Calculator, TextEdit, Safari ใต้ `/System/Applications`) **ไม่นับ** เป็น system

---

## 7. Intelligence rules

ทั้งหมดเป็น deterministic rules (ไม่มี AI) ตัวเลขรวมอยู่ใน `THRESHOLDS` และค่าคงที่ใน service

### 7.1 Health
- macOS: เชื่อ **memory pressure ที่ OS รายงาน** (`kern.memorystatus_vm_pressure_level`) เป็นหลัก
  - critical → **Critical**, warn หรือ swap กำลังโต → **High**, used ≥ 85% แต่ pressure ปกติ → **Moderate**, อื่นๆ → **Healthy**
- Windows / ไม่มี pressure: used ≥ 95% + swap โต → Critical, ≥ 85% หรือ swap โต → High, ≥ 70% → Moderate
- "Used" นับแบบ Activity Monitor: app memory + wired + compressed (file cache ไม่นับ)
- **Swap กำลังโต** = เขียนลง swap ≥ 1 MB/s เฉลี่ยใน 60 วินาที (swap ที่ค้างอยู่เฉยๆ ไม่นับ)

### 7.2 แอปที่ไม่ได้ใช้ (Smart Cleanup)
แอปจะถูกแนะนำเมื่อผ่าน **ทุกข้อ**

| เงื่อนไข | ค่า |
|---|---|
| ไม่ได้อยู่หน้าสุด (ขณะผู้ใช้อยู่หน้าเครื่อง) | ≥ 20 นาที |
| ผู้ใช้ไม่แตะเครื่องเกินนี้ = ไม่นับว่า "ใช้" | 2 นาที |
| CPU เบื้องหลัง (รวมทุก process ของแอป) | < 5% |
| Memory | ≥ 200 MB |
| ไม่ใช่ System / Protected / host ของ MemNEX | — |
| ผู้ใช้ไม่ได้ "เก็บไว้" ซ้ำ | < 3 ครั้ง |

- มี memory pressure (High/Critical) → `recommended` (ติ๊กไว้, pill Review)
- pressure ปกติ → `suggested` (Optional, ไม่ติ๊ก)
- แอปที่ไม่เคยเห็นอยู่หน้าสุดเลย → เวลาเป็น **ขอบล่าง** แสดงเป็น "at least" / "≥"
- ช่วงแรก 5 นาที: ไม่รู้ = ไม่แนะนำ; ต้องสังเกต ~20 นาทีก่อนคำแนะนำแรก
- ถ้า MemNEX หยุดไปเกิน 10 นาที เริ่มนับการสังเกตใหม่ (ไม่รู้ว่าระหว่างนั้นใช้อะไร)
- Sampling: ทุก 5 วินาที (Windows 10 วินาที)

### 7.3 Memory growth (possible leak → Restart)
- เก็บตัวอย่าง memory ต่อแอปทุก 20 วินาที ในหน้าต่าง 45 นาที (ในหน่วยความจำ)
- นับว่าโตเมื่อ: เพิ่ม ≥ 500 MB **และ** ≥ 30% จากจุดต่ำสุด, ช่วงเวลา ≥ 10 นาที, และ 3 ตัวอย่างล่าสุดยังสูงอยู่ (spike ที่ลดลงแล้วไม่นับ)
- ระบุ **process ที่โต** ถ้าคิดเป็น ≥ 40% ของที่โต เช่น "mostly in Code Helper (Plugin)"
- แอป restart (main PID เปลี่ยน) → เริ่มนับใหม่

### 7.4 เรียนรู้จากการตัดสินใจ
- แอปที่แสดงใน cleanup แต่ผู้ใช้ไม่ติ๊ก → นับ +1; ถ้าเลือกปิด → รีเซ็ต
- ครบ 3 ครั้ง → หยุดแนะนำ, แสดง "Idle, but you usually keep it open", แก้ได้ที่ Settings

### 7.5 Diagnosis (ลำดับการตัดสิน)
1. **Memory ตึง** → ชี้สาเหตุตามลำดับ: แอปที่ memory โต → แอปที่ไม่ได้ใช้ (2 อันดับแรก) → ถ้าไม่มี บอกตรงๆ ว่าแอปที่กำลังใช้อยู่คือตัวการ (และถ้ายังเรียนรู้ไม่ครบให้บอกว่ากำลังเรียนรู้)
2. **ไม่ใช่ memory แต่เครื่องช้า** → `kernel_task` > 100% CPU = เครื่องร้อน; Spotlight > 60% = indexing ชั่วคราว; CPU รวม > 80% → แอปที่ใช้ CPU มากที่สุด
3. **ปกติ** → ถ้ามีแอปโตต่อเนื่อง เตือนล่วงหน้า; ไม่งั้น "Everything is running smoothly." และไม่มีปุ่ม

ผลลัพธ์ทุกครั้ง: headline 1 ประโยค + detail + evidence ที่ตรวจสอบได้ + action ไม่เกิน 2

---

## 8. Copy

- ภาษาในแอปเป็นภาษาอังกฤษ, ประโยคสั้น, บอกเหตุผลเสมอ
- Error ต้องบอกเหตุผลที่ผู้ใช้ทำต่อได้ (PRD §26) — `Permission denied…`, `Process no longer exists…`, `System protected…`, `Application refused graceful close…`, `Unsupported operation…`, และเมื่อ API ไม่ตอบ: `Lost connection to MemNEX's local service…`
- **ห้าม:** "Something went wrong", "Boost", "Free RAM", "Optimized!", health score 0–100
- บอกความไม่แน่นอน: "Estimate…", "at least", "MemNEX is still learning…"
- Reason chips ของแอปใช้รูปแบบเดียวกัน: `Not used for 45 min · 800 MB in memory · Idle in background`

---

## 9. Accessibility

- `:focus-visible` outline 2px สี azure ทุก element ที่โต้ตอบได้
- สถานะไม่สื่อด้วยสีอย่างเดียว — มีข้อความ (pill, คำสถานะ) และไอคอนกุญแจเสมอ
- Meter มี `role="meter"` + `aria-valuenow`; nav ใช้ `aria-current`; filter ใช้ `role="tab"` + `aria-selected`; live status ใช้ `aria-live="polite"`; modal ใช้ `role="dialog" aria-modal`
- ตัวอักษรเล็กสุด 12px
- `prefers-reduced-motion` ปิด transition
- ตัวอักษรบนสีสถานะใช้ navy (ยกเว้นแดงใช้ขาว) — **ยังไม่ได้วัด contrast อย่างเป็นทางการ** ควรตรวจ WCAG ก่อน release

---

## 10. Data และ footprint

- **ไม่มี database ใดๆ** (ไม่มี SQLite) — ตั้งใจให้แอปเล็กที่สุด
- ข้อมูลในหน่วยความจำ (หายเมื่อปิด): cleanup history (สูงสุด 50), memory series, รายการแอปที่ปิดสำหรับ Reopen
- ไฟล์บนดิสก์ใน `apps/workbench-api/.memnex/`:
  - `settings.json` — protected apps + ตัวนับ kept-open (โหลดครั้งเดียว, write-through)
  - `activity.json` — เวลาใช้งานล่าสุดต่อแอป (~400 B, เก็บสูงสุด 7 วัน)
  - `icons/` — PNG cache ของไอคอนแอป
- ไม่มีข้อมูลออกนอกเครื่อง
- Polling: snapshot ทุก 3 วินาที

---

## 11. ยังไม่ได้ทำ / ข้อจำกัด

- Windows adapter ยังไม่ได้ทดสอบบนเครื่องจริง (activity, quit, reopen, parent pid)
- Thresholds ยังเป็นค่าที่เลือกจากความสมเหตุสมผล ยังไม่ได้ปรับจากการใช้งานจริง และยังตั้งค่าจาก UI ไม่ได้
- ยังไม่ได้วัด WCAG contrast
- ยังไม่มี: การหา dev server ที่ถูกลืม, SSE แทน polling (PRD §24), API endpoints ตาม PRD §23 ทุกตัว
