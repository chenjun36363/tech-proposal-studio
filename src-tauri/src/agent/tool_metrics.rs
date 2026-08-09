use crate::app_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolQualityMetricInput {
    protocol: String,
    model: String,
    tool_name: String,
    result_kind: String,
    #[serde(default)]
    error_code: Option<String>,
    round: i64,
    repaired: bool,
    duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolQualityMetricRow {
    pub day: String,
    pub protocol: String,
    pub model: String,
    pub tool_name: String,
    pub result_kind: String,
    pub error_code: Option<String>,
    pub round_bucket: String,
    pub repaired: bool,
    pub duration_bucket: String,
    pub count: i64,
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let db = Connection::open(dir.join("workspace.db"))
        .map_err(|error| format!("打开工具质量数据库失败: {error}"))?;
    initialize_schema(&db)?;
    Ok(db)
}

pub(crate) fn initialize_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_tool_quality_metrics(
            day TEXT NOT NULL,
            protocol TEXT NOT NULL,
            model TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            result_kind TEXT NOT NULL,
            error_code TEXT NOT NULL DEFAULT '',
            round_bucket TEXT NOT NULL,
            repaired INTEGER NOT NULL,
            duration_bucket TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(day, protocol, model, tool_name, result_kind, error_code, round_bucket, repaired, duration_bucket)
        );",
    )
    .map_err(|error| format!("初始化工具质量指标表失败: {error}"))
}

fn round_bucket(round: i64) -> &'static str {
    match round {
        1 => "1",
        2 => "2",
        3..=5 => "3-5",
        _ => "6+",
    }
}

fn duration_bucket(duration_ms: u64) -> &'static str {
    match duration_ms {
        0..=99 => "<100ms",
        100..=499 => "100-499ms",
        500..=1999 => "500ms-2s",
        2000..=9999 => "2-10s",
        _ => "10s+",
    }
}

#[tauri::command]
pub(crate) fn record_agent_tool_quality_metric(
    app: AppHandle,
    metric: ToolQualityMetricInput,
) -> Result<(), String> {
    let db = open_db(&app)?;
    db.execute(
        "INSERT INTO agent_tool_quality_metrics(day, protocol, model, tool_name, result_kind, error_code, round_bucket, repaired, duration_bucket, count)
         VALUES(date('now', 'localtime'), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
         ON CONFLICT(day, protocol, model, tool_name, result_kind, error_code, round_bucket, repaired, duration_bucket)
         DO UPDATE SET count = count + 1",
        params![
            metric.protocol.trim(),
            metric.model.trim(),
            metric.tool_name.trim(),
            metric.result_kind.trim(),
            metric.error_code.unwrap_or_default().trim(),
            round_bucket(metric.round),
            if metric.repaired { 1 } else { 0 },
            duration_bucket(metric.duration_ms),
        ],
    )
    .map_err(|error| format!("保存工具质量指标失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_agent_tool_quality_metrics(
    app: AppHandle,
    days: Option<i64>,
) -> Result<Vec<ToolQualityMetricRow>, String> {
    let keep_days = days.unwrap_or(30).clamp(1, 365);
    let db = open_db(&app)?;
    let mut statement = db.prepare(
        "SELECT day, protocol, model, tool_name, result_kind, error_code, round_bucket, repaired, duration_bucket, count
         FROM agent_tool_quality_metrics
         WHERE day >= date('now', 'localtime', ?1)
         ORDER BY day DESC, count DESC, tool_name ASC",
    ).map_err(|error| format!("读取工具质量指标失败: {error}"))?;
    let offset = format!("-{} days", keep_days - 1);
    let rows = statement
        .query_map(params![offset], |row| {
            let error_code: String = row.get(5)?;
            Ok(ToolQualityMetricRow {
                day: row.get(0)?,
                protocol: row.get(1)?,
                model: row.get(2)?,
                tool_name: row.get(3)?,
                result_kind: row.get(4)?,
                error_code: (!error_code.is_empty()).then_some(error_code),
                round_bucket: row.get(6)?,
                repaired: row.get::<_, i64>(7)? != 0,
                duration_bucket: row.get(8)?,
                count: row.get(9)?,
            })
        })
        .map_err(|error| format!("读取工具质量指标失败: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取工具质量指标失败: {error}"))
}

#[tauri::command]
pub(crate) fn clear_agent_tool_quality_metrics(app: AppHandle) -> Result<(), String> {
    let db = open_db(&app)?;
    db.execute("DELETE FROM agent_tool_quality_metrics", [])
        .map_err(|error| format!("清空工具质量指标失败: {error}"))?;
    Ok(())
}
