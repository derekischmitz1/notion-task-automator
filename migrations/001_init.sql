CREATE TABLE processed_emails (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(255) UNIQUE NOT NULL,
    pull_date DATE NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE processed_tasks (
    id SERIAL PRIMARY KEY,
    notion_id VARCHAR(255) UNIQUE NOT NULL,
    task_name VARCHAR(255) NOT NULL,
    category VARCHAR(255) NOT NULL,
    pull_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_daily_task UNIQUE (task_name, category, pull_date)
);

CREATE TABLE category_placeholders (
    id SERIAL PRIMARY KEY,
    category VARCHAR(255) NOT NULL,
    pull_date DATE NOT NULL,
    notion_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_category_date UNIQUE (category, pull_date)
);

CREATE TABLE sync_history (
    id SERIAL PRIMARY KEY,
    task_notion_id VARCHAR(255) NOT NULL,
    assignment_notion_id VARCHAR(255) NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_sync UNIQUE (task_notion_id, assignment_notion_id)
);