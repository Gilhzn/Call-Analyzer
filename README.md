# 🎧 מנתח שיחות — Call Analyzer

אפליקציית web לניתוח שיחות מוקלטות: מעלים הקלטת שיחה, מקבלים **תמליל מלא** לצד **ניתוח עסקי** — סיכום, נקודות חשובות, משימות להמשך, אפיון משתתפים, סנטימנט ונושאים. הכול רץ **מקומית** על המחשב/שרת שלכם: התמלול עם [Whisper](https://github.com/SYSTRAN/faster-whisper) והניתוח עם מודל שפה מקומי דרך [Ollama](https://ollama.com) — ללא מפתחות API וללא עלות.

## 🔒 פרטיות

- **ההקלטה לא נשמרת.** הקובץ נכתב לקובץ זמני בלבד לצורך התמלול ו**נמחק מיד** בסיומו (עוד לפני שלב הניתוח).
- **שום דבר לא יוצא החוצה.** התמלול והניתוח מתבצעים כולם על המכונה המקומית — אין שליחה לשירותי ענן.
- **אין בסיס נתונים ואין לוגים של תוכן.** ביומן השרת נרשמים רק מזהה משרה אקראי, גדלים וזמנים — לעולם לא שם הקובץ, התמליל או הסיכום.
- **התוצאות חיות רק בדפדפן.** רשומת המשרה בזיכרון נמחקת ברגע שהזרם נסגר (או אחרי 10 דקות אם הדפדפן התנתק).

## 🌐 דמו חי — לינק ציבורי (GitHub Pages)

**<https://gilhzn.github.io/Call-Analyzer/>** — נפתח מכל מקום, ללא התקנה.

בגרסת הדמו הכול רץ **בתוך הדפדפן שלכם** (תמלול עם transformers.js וניתוח עם WebLLM) — הקובץ לא נשלח לשום שרת, אפילו לא לשרת של האפליקציה. בהפעלה הראשונה יורדים קובצי מודל (חד-פעמי, נשמר במטמון). הניתוח העסקי דורש דפדפן עם WebGPU (Chrome/Edge עדכניים במחשב); ללא WebGPU יופק תמליל בלבד. איכות ומהירות מלאות — בגרסה המקומית או ב-Codespaces שלמטה.

## ▶️ בדיקה מהירה בענן — GitHub Codespaces

אין צורך להתקין כלום על המחשב: לוחצים על הקישור, GitHub מרים שרת חינמי עם הכול מותקן, והאפליקציה נפתחת בדפדפן.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Gilhzn/Call-Analyzer/tree/claude/conversation-analyzer-whisper-f8llbc?quickstart=1)

1. לוחצים על הכפתור למעלה (או: בעמוד הריפו — **Code ‹› → Codespaces → Create codespace**).
2. ממתינים להקמה חד-פעמית (~5–10 דקות: התקנת התלויות והורדת המודלים).
3. האפליקציה עולה אוטומטית על פורט 8000 — GitHub יציג חלונית "Open in Browser", או שנכנסים ללשונית **Ports** ולוחצים על הגלובוס ליד פורט 8000.
4. גוררים הקלטת שיחה ובודקים.

> ההרצה בענן היא לצורך בדיקה בלבד — ב-Codespace הפרטי שלכם. לפרטיות מלאה (ההקלטה לא עוזבת את המחשב) הריצו מקומית לפי ההוראות בהמשך. שימו לב שהמכונה החינמית איטית יחסית — ניתוח שיחה יכול לקחת דקה-שתיים.

## דרישות מוקדמות

- Python 3.10 ומעלה
- [Ollama](https://ollama.com/download) מותקן (לניתוח העסקי; התמלול עובד גם בלעדיו)
- זיכרון: ‎~2GB למודל תמלול `small` + ‎~4GB למודל ניתוח `gemma3:4b`

## התקנה

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# מודל הניתוח (חד-פעמי):
ollama pull gemma3:4b

# הגדרות (אופציונלי — יש ברירות מחדל טובות):
cp .env.example .env
```

> אין צורך להתקין ffmpeg — הפענוח נעשה עם ספריות מובנות (PyAV).

## הרצה

```bash
ollama serve                     # אם Ollama לא רץ כבר כשירות
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

פותחים דפדפן בכתובת <http://localhost:8000>, גוררים קובץ שמע — והתמליל מופיע בזמן אמת, ואחריו הניתוח העסקי. לכל חלון יש כפתור העתקה.

בהעלאה הראשונה מודל ה-Whisper יורד אוטומטית (~460MB עבור `small`) — זה חד-פעמי.

## בחירת מודלים

### תמלול (`WHISPER_MODEL`)

| מודל | גודל | מהירות (CPU) | איכות עברית |
|---|---|---|---|
| `small` (ברירת מחדל) | ‎~460MB | מהיר | טובה |
| `medium` | ‎~1.5GB | איטי פי ‎~3 | טובה מאוד |
| `large-v3-turbo` | ‎~1.6GB | בינוני | מצוינת |
| `ivrit-ai/whisper-large-v3-turbo-ct2` | ‎~1.6GB | בינוני | **הטובה ביותר לעברית** (מודל קהילתי מכוון) |

### ניתוח (`OLLAMA_MODEL`)

| מודל | זיכרון | איכות עברית | הערות |
|---|---|---|---|
| `gemma3:4b` (ברירת מחדל) | ‎~4GB | טובה | איזון מצוין בין איכות למשאבים |
| `aya-expanse:8b` | ‎~8GB | **הטובה ביותר** | עברית היא שפה רשמית של המודל |
| `qwen2.5:7b` | ‎~7GB | סבירה | משמעת JSON חזקה |

כל ההגדרות במשתני סביבה — ראו [`.env.example`](.env.example).

## פתרון תקלות

| בעיה | פתרון |
|---|---|
| באנר "שירות Ollama אינו פעיל" | הריצו `ollama serve` (התמלול עובד גם בלי Ollama) |
| "מודל הניתוח אינו מותקן" | `ollama pull gemma3:4b` |
| תמלול איטי מאוד | ודאו `WHISPER_COMPUTE_TYPE=int8`; עברו למודל קטן יותר; או `WHISPER_DEVICE=cuda` אם יש GPU |
| הבקשה הראשונה איטית | הורדת מודל + טעינה חד-פעמית; אפשר `WHISPER_PRELOAD=true` לטעינה בעליית השרת |
| עברית משובשת בתמליל | עברו ל-`large-v3-turbo` או למודל של ivrit-ai (ראו טבלה) |

## בדיקה בלי הקלטה אמיתית

```bash
# יצירת קובץ בדיקה מדיבור סינתטי בעברית (דורש espeak-ng):
espeak-ng -v he -s 140 "שלום, מדבר יוסי מחברת אלפא. רציתי לתאם פגישה ליום שלישי בנושא הצעת המחיר. נא לשלוח את החוזה עד סוף השבוע." -w test_he.wav

# דרך ה-API:
curl -s -F file=@test_he.wav http://localhost:8000/api/analyze     # ← job_id
curl -N http://localhost:8000/api/jobs/<job_id>/stream             # ← אירועי SSE חיים
```

## API

| Method | Path | תיאור |
|---|---|---|
| `POST` | `/api/analyze` | העלאת קובץ (multipart, שדה `file`) → `{"job_id": "..."}` |
| `GET` | `/api/jobs/{id}/stream` | זרם SSE: `status` → `segment`… → `transcript_done` → `analysis` → `done` (או `error`) |
| `GET` | `/api/health` | מצב השרת, מודל התמלול וזמינות Ollama |

---

### English summary

Local, private call-analysis web app: upload a recorded call, get a live transcript (faster-whisper) and a structured business analysis — summary, key points, action items, participants, sentiment, topics — from a local LLM via Ollama. Nothing is stored: audio lives only in an ephemeral temp file deleted right after transcription, there is no database, and content is never logged. Setup: `pip install -r requirements.txt`, `ollama pull gemma3:4b`, `uvicorn app.main:app`.
