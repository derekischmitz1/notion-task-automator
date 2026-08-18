# **Notion Task Automator**

An automated, two-way synchronization engine built with Node.js, TypeScript, PostgreSQL, and Gemini AI. This system processes daily schedule emails, generates structured tasks in Notion, automatically blocks off calendar slots on Google Calendar, checks across multiple calendars for scheduling conflicts, and keeps task updates synced bi-directionally between Notion and Google Calendar.

## **🌟 Key Features**

* **AI Email Parsing:** Ingests inbound schedule emails via Gmail Pub/Sub webhooks and parses structured tasks using Gemini AI.
* **Category-Aware Deduplication:** Manages daily task entries in Notion without blocking recurring or category-specific tasks.
* **Google Calendar Integration:** Dynamically schedules timed events on a dedicated target calendar (e.g., Tentative/Travel calendar).
* **Multi-Calendar Free/Busy Conflict Engine:** Scans your primary Google Calendar, target sub-calendars, external Google Calendars, and external Outlook ICS feeds simultaneously before blocking off time.
* **Bi-Directional Time Syncing:** Monitors Notion for time or title updates on timed tasks every 5 minutes and updates corresponding Google Calendar event blocks dynamically using events.patch.
* **Notion Academic Assignment Sync:** Matches daily tasks with your master Notion Assignments database and marks linked coursework as complete when finished.
* **PostgreSQL State Tracking:** Persists Notion Page IDs, Google Calendar Event IDs, and sync histories to avoid duplicate API calls and infinite retry loops.

## **🏗 System Architecture**

```
[ Gmail Inbound / Webhook ]
        │
        ▼
   [ Express API Server ] ──► [ Gemini AI Service ] (Extract Tasks)
        │
        ▼
    [ Notion Service ] ──► Creates Daily Tasks in Notion Database
        │
        ▼
    [ Sync Service ] ◄──► [ PostgreSQL Database ]
      (Runs every 5m)
        │
  ┌─────┴──────────────────────────────────┐
  ▼                                        ▼
[ Google Calendar API ]               [ Multi-Calendar Check ]
• Creates/Patches Events              • Primary & Secondary GCals
• Handles Free/Busy Queries           • External Outlook ICS Feeds
```

## **🛠 Tech Stack**

* **Runtime:** Node.js, TypeScript
* **Framework:** Express.js
* **Database:** PostgreSQL (with pg connection pooling)
* **AI Engine:** Google Gemini AI API (@google/genai)
* **Integrations:**
  * Notion API (@notionhq/client)
  * Google Calendar & Gmail API (googleapis)
  * ical.js (for parsing external Outlook ICS calendar feeds)
  * node-cron / Custom Background Scheduler

## **📁 Project Structure**

```
├── src/
│   ├── config/          # Database and environmental configurations
│   ├── controllers/     # Route handlers (Gmail Pub/Sub webhooks)
│   ├── jobs/            # Standalone cron jobs and runners
│   ├── services/        # Core business logic
│   │   ├── calendar.service.ts # GCal API & multi-calendar conflict detection
│   │   ├── gemini.service.ts   # Gemini AI prompt engineering & task extraction
│   │   ├── notion.service.ts   # Notion database & page operations
│   │   └── sync.service.ts     # Master sync orchestrator & edit detection
│   ├── utils/           # Shared loggers, date parsers, and background schedulers
│   └── server.ts        # Express application entrypoint
├── database.sql         # Initial database scheme definitions
└── package.json
```

## **⚙️ Environment Variables**

Create a .env file in the root directory and populate the following keys:

```bash
# Server Setup
PORT=3000

# PostgreSQL Configuration
DATABASE_URL=postgresql://user:password@localhost:5432/notion_automator

# Gemini AI API
GEMINI_API_KEY=your_gemini_api_key

# Notion Integration
NOTION_API_KEY=secret_your_notion_api_key
NOTION_DATABASE_ID=your_daily_tasks_database_id
NOTION_SYSTEM_SETTINGS_DB_ID=your_system_settings_database_id
NOTION_ASSIGNMENTS_DB_ID=your_assignments_database_id

# Google Calendar & Gmail Integration
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REFRESH_TOKEN=your_google_refresh_token
GOOGLE_CALENDAR_ID=your_target_google_calendar_id
GMAIL_PUBSUB_TOPIC=projects/your-project/topics/gmail-events

# Conflict Check Extensions (Optional)
EXTERNAL_GCAL_IDS=cal1@group.calendar.google.com,cal2@group.calendar.google.com
OUTLOOK_ICS_URLS=https://outlook.office365.com/owa/calendar/.../reachcalendar.ics
```

## **🚀 Getting Started**

### **Prerequisites**

* Node.js v18+
* PostgreSQL installed and running
* A Google Cloud Project with Gmail API and Google Calendar API enabled
* A Notion Integration Token with access to your target databases

### **Installation**

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/notion-task-automator.git
   cd notion-task-automator
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Database Setup:**
   Initialize your PostgreSQL database using database.sql to create the required processed_tasks and sync_history tables.

4. **Build the application:**
   ```bash
   npm run build
   ```

5. **Start the server:**
   ```bash
   npm start
   ```

## **🔄 Sync Workflows**

### **1\. Inbound Schedule Parsing**

* An inbound email triggers the /api/webhooks/gmail route.
* Gemini extracts structured task blocks (taskName, category).
* Tasks are populated directly inside your Notion Task Manager.

### **2. Timed Event Creation**

* SyncService.syncCalendarEvents() scans for newly added timed tasks (e.g., 2.0945: Prep for meeting).
* Runs a conflict check across primary GCals, sub-calendars, and external Outlook feeds.
* Blocks off the time in Google Calendar and writes the gcal_event_id back to PostgreSQL.

### **3. Bi-Directional Time Edit Sync**

* Every 5 minutes, SyncService.syncNotionTaskUpdates() queries Notion for today's timed tasks.
* If a title or time tag changes in Notion (e.g., updated from 2.0945 to 2.1140), the system detects the change.
* Verifies the target slot is free and patches the existing block on Google Calendar instantly.
