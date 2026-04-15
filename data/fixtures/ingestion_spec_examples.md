# Ingestion Specification Guidelines

To ensure the Code-Gen Agent produces accurate Airflow DAGs and Snowflake transformations, use the following natural language patterns when describing new data pipelines.

## Standard Description Components
A complete specification should include:
1. **Source System**: Where the data is coming from (S3, Postgres, API, etc.)
2. **Frequency**: Cron or Airflow schedule alias.
3. **Logic/Transformation**: Specific filtering, joining, or windowing requirements.
4. **Target Table**: The schema name defined in `target_schemas.yaml`.

---

## Example 1: Simple S3 to Snowflake (Raw Ingestion)
"Create a daily DAG named `s3_to_snowflake_orders_raw`. It should monitor the `s3://company-data-lake/raw/orders/` bucket for new Parquet files. Load these into the `RAW.ORDERS` table. Use the `S3ToSnowflakeOperator` with a `pattern` match for current date. Ensure the `load_timestamp` column is populated with the execution time."

## Example 2: API Ingestion with Secrets
"Build a pipeline that runs every 4 hours to fetch JSON data from the `Stripe` Charges API. Use the `stripe_api_default` connection ID. The data needs to be flattened and inserted into `FINANCE.STRIPE_CHARGES`. If a charge ID already exists, overwrite the record (Upsert logic). Include a data quality check to ensure `amount` is never null."

## Example 3: Complex Transformation (DB to DB)
"Generate a DAG scheduled for `@weekly` on Sunday at 02:00. Extract data from the `production_replica` Postgres database from the `subscriptions` table. Join this with the `marketing_leads` table in Snowflake. The logic should calculate the 'Customer Acquisition Cost' (CAC) per region. The output should be written to `ANALYTICS.MARKETING_PERFORMANCE`. Handle late-arriving data by looking back 3 days in the source query."

## Example 4: Incremental Load with Watermarking
"Create an hourly DAG for `LOG_PROCESSOR`. Read from the `app_logs` table in the `LOGGING` schema. Perform an incremental load into `STAGING.APP_EVENTS` based on the `event_id` and `created_at` timestamp. Use the `IncrementalSnowflakeOperator` and ensure we only process records where `created_at` is greater than the max timestamp currently in the target table."

---

## Key Keywords for Logic Mapping
*   **"Upsert" / "Merge"**: Agent will use `SnowflakeMergeOperator` or a temporary staging table pattern.
*   **"Backfill"**: Agent will set `catchup=True` and define a specific `start_date`.
*   **"Quality Check"**: Agent will append `SnowflakeCheckOperator` tasks after the load.
*   **"Slack Alert"**: Agent will include an `on_failure_callback` using the `SlackWebhookOperator`.

## Formatting Constraints
*   Always reference the target table name exactly as it appears in `target_schemas.yaml`.
*   Specify if the pipeline requires a `Virtualenv` or specific Python dependencies if using the `PythonOperator`.
