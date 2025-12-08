# 🌐 **Spry for DevOps / SRE — Executable Documentation for Reliability Automation**

Spry allows DevOps and SRE teams to define, document, and automate operational
workflows in **executable Markdown**. Instead of using scattered scripts, tribal
knowledge, or outdated runbooks, Spry unifies:

- Documentation
- Automation scripts
- Monitoring & health checks
- Incident response runbooks
- Infrastructure provisioning logic

All in **version-controlled Markdown**.

---

# 🚀 What is Spry for DevOps / SRE?

Spry for DevOps/SRE enables teams to:

- Codify infrastructure automation
- Build self-documenting runbooks
- Execute health checks and recovery tasks
- Standardize deployments, scaling, and incident workflows
- Reduce human error through repeatable automated tasks

Every runbook becomes a **reliable automation unit**, stored next to your source
code.

---

# 🎯 Why DevOps / SRE Teams Use Spry

### ✔ **Unified documentation + execution**

One source of truth for docs + automation.

### ✔ **Version-controlled processes**

Operational changes are tracked in Git — enabling audit, rollback, and review.

### ✔ **Reproducible reliability workflows**

Same behavior across Dev / Staging / Production.

### ✔ **Executable runbooks**

Tasks such as:

- deploy
- rollback
- incident-response
- scale
- backup-validate
- security-scan

…can be executed directly from Markdown.

### ✔ **Better onboarding**

New engineers learn by reading + running the same executable docs.

---

# 🛠️ Getting Started

### **Prerequisites**

- Spry CLI installed [https://sprymd.org/docs/getting-started/installation/]

### **Initialize project**

You may:

- Use an existing Spry repository, or
- Create a new SRE/Infra automation module

---

# 🖥️ **Linux Monitoring Runbooks — Core Tasks**

These tasks are **simple, critical, and ideal for demos**, onboarding, and real
SRE/DevOps usage.

They include checks for:

- CPU
- Memory
- Disk
- SSH security
- Critical services

---

# 1️⃣ **CPU Utilization Monitoring**

### **Purpose:**

Detect CPU overload conditions and notify when CPU usage exceeds 80%.

---

## ✔ Example Spry Task

```bash CPU-Utilization --descr "Check CPU utilization using osquery and notify if threshold crossed"
#!/usr/bin/env -S bash

THRESHOLD=80
EMAIL="devops-team@example.com"

# Get CPU usage using osquery (more accurate than parsing top)
CPU_USAGE=$(osqueryi --json "
  SELECT 
    ROUND(AVG(100.0 - (idle * 100.0 / (user + system + idle + nice))), 2)
    AS avg_cpu_usage_percent 
  FROM cpu_time;
" | jq -r '.[0].avg_cpu_usage_percent')

CPU_INT=$(printf "%.0f" "$CPU_USAGE")

echo "Current CPU Usage: ${CPU_INT}%"

if [ "$CPU_INT" -gt "$THRESHOLD" ]; then
    SUBJECT="ALERT: High CPU Usage on $(hostname)"
    BODY="CPU usage is ${CPU_INT}% (Threshold: ${THRESHOLD}%)."
    echo "$BODY" | mail -s "$SUBJECT" "$EMAIL"
    exit 1
fi

echo "✅ CPU usage normal"
```

# 2️⃣ **Disk Usage Monitoring**

Alerts when the root filesystem exceeds 80% usage.

```bash check-disk --descr "Check root disk usage"
#!/usr/bin/env -S bash

THRESHOLD=80
USAGE=$(df -h / | awk 'NR==2 {gsub("%","",$5); print $5}')

echo "Disk Usage: ${USAGE}%"

if [ "$USAGE" -gt "$THRESHOLD" ]; then
  echo "🚨 ALERT: Disk usage exceeded ${THRESHOLD}%"
  exit 1
fi

echo "✅ Disk usage normal"
```

# 3️⃣ **Memory Usage Monitoring**

Monitors RAM utilization and triggers alert if crossing 80%.

```bash check-memory --descr "Check memory usage percentage"
#!/usr/bin/env -S bash

THRESHOLD=80
USED=$(free | awk '/Mem:/ {printf("%d"), ($3/$2)*100}')

echo "Memory Usage: ${USED}%"

if [ "$USED" -gt "$THRESHOLD" ]; then
  echo "🚨 ALERT: High memory usage"
  exit 1
fi

echo "✅ Memory usage normal"
```

# 4️⃣ **Failed SSH Login Detection**

Detects brute-force attempts and abnormal SSH activity.

```bash check-ssh-fail --descr "Detect failed SSH login attempts"
#!/usr/bin/env -S bash

THRESHOLD=10
FAILS=$(grep -c "Failed password" /var/log/auth.log)

echo "Failed SSH Logins: $FAILS"

if [ "$FAILS" -gt "$THRESHOLD" ]; then
  echo "🚨 ALERT: Possible brute-force attack"
  exit 1
fi

echo "✅ SSH login activity normal"
```

# 5️⃣ **Critical Service Availability Check**

Ensures critical system services (example: nginx) are running.

This version uses **osquery** to detect the correct master process.

```bash check-Service-runnning --decr "Check if Critical Service is Running"
#!/usr/bin/env bash

SERVICE="nginx"
EMAIL="devops-team@example.com"

# Check only the master process via osquery
IS_RUNNING=$(osqueryi --json "
SELECT count(*) AS running
FROM processes
WHERE name = '${SERVICE}' AND cmdline LIKE '%: master%';
" | jq -r '.[0].running')

echo "Master process count: $IS_RUNNING"

if [ "$IS_RUNNING" -eq 0 ]; then
    SUBJECT="ALERT: Service $SERVICE Not Running"
    BODY="Critical service '$SERVICE' is NOT running on $(hostname)."

    echo "$BODY" | mail -s "$SUBJECT" "$EMAIL"
    echo "⚠️ Alert email sent!"
else
    echo "✅ $SERVICE is running."
fi
```
