SQLfolio end-to-end (`e2e`) assurance example.

- `sql` blocks are obvious
- `--migratable` wraps the SQL into "guarded" CTEs

```code DEFAULTS
sql * --interpolate --injectable --executable --capture
```

```yaml CONNECTIONS
spawnables:
  prime:
    engine: sqlite
    file: "prime.sqlite.db"
```

```bash clean --graph housekeeping
rm -f prime.sqlite.db
```

```sql migrations -X prime --migratable
DROP TABLE IF EXISTS billing_payments;
DROP TABLE IF EXISTS billing_invoices;
DROP TABLE IF EXISTS sales_orders;
DROP TABLE IF EXISTS sales_customers;

CREATE TABLE IF NOT EXISTS sales_customers (
    customer_id INT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    Phone TEXT NULL,
    email TEXT NOT NULL,
    country TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_email ON sales_customers(email);

-- @annotation
CREATE TABLE IF NOT EXISTS sales_orders (
    order_id       INT PRIMARY KEY,
    customer_id    INT NOT NULL,
    total_amount   NUMERIC(10,2) NOT NULL,
    status         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_invoices (
    invoice_id      INT PRIMARY KEY,
    order_id        INT NOT NULL,
    invoice_amount  NUMERIC(10,2) NOT NULL,
    invoice_date    DATE NOT NULL,
    CONSTRAINT fk_invoice_order
        FOREIGN KEY (order_id)
        REFERENCES sales_orders(order_id)
);

CREATE TABLE IF NOT EXISTS billing_payments (
    payment_id   INT PRIMARY KEY,
    invoice_id   INT NOT NULL,
    amount       NUMERIC(10,2) NOT NULL,
    payment_date DATE NOT NULL,
    CONSTRAINT fk_payment_invoice
        FOREIGN KEY (invoice_id)
        REFERENCES billing_invoices(invoice_id)
);
```

Seed the database.

```sql seed --executable prime
DELETE FROM billing_payments;
DELETE FROM billing_invoices;
DELETE FROM sales_orders;
DELETE FROM sales_customers;

INSERT INTO sales_customers (customer_id, customer_name, phone, email, country)
VALUES
  (1, 'John',  '111-222-333', 'a1@test.com', 'IN'),
  (2, 'Bob',   '333-44-555',  'b1@test.com', 'US'),
  (3, 'Alice', '555-444-444', 'c1@test.com', 'IN'),
  (4, 'Sarah', '111-777-333', 'd1@test.com', 'IN');

INSERT INTO sales_orders (order_id, customer_id, total_amount, status)
VALUES
  (1, 1, 500.00, 'COMPLETED'),
  (2, 2, 300.00, 'COMPLETED'),
  (3, 3, 700.00, 'COMPLETED'),
  (4, 4, 400.00, 'PENDING');

INSERT INTO billing_invoices (invoice_id, order_id, invoice_amount, invoice_date)
VALUES
  (1, 1, 500.00, CURRENT_DATE),  -- matches order total
  (2, 2, 250.00, CURRENT_DATE),  -- mismatch with order
  (3, 3, 700.00, CURRENT_DATE),  -- matches order
  (4, 4, 150.00, CURRENT_DATE);  -- mismatch with order

INSERT INTO billing_payments (payment_id, invoice_id, amount, payment_date)
VALUES
  (1, 1, 300.00, CURRENT_DATE),
  (2, 1, 200.00, CURRENT_DATE), -- full payment

  (3, 2, 100.00, CURRENT_DATE),
  (4, 2, 100.00, CURRENT_DATE), -- partial payment (invoice = 250)

  (5, 3, 700.00, CURRENT_DATE), -- full payment

  (6, 4, 100.00, CURRENT_DATE); -- partial payment (invoice = 150)
```

```sql validate-idempotency -X prime
INSERT OR IGNORE INTO sales_customers (
    customer_id,
    customer_name,
    phone,
    email,
    country
)
VALUES
(5, 'Pradeep', '111-222-333', 'pradeep@test.com', 'IN');

INSERT OR IGNORE INTO sales_customers (
    customer_id,
    customer_name,
    phone,
    email,
    country
)
VALUES
(6, 'Pradeep', '111-222-333', 'pr1@test.com', 'IN');

-- Prevents duplicate billing, double processing
-- Validates safe retry behavior

SELECT COUNT(*) AS result
FROM sales_customers
WHERE email = 'pradeep@test.com';
```

```sql validate-invoice-payment --executable prime
SELECT
    c.customer_name,
    o.order_id,
    o.total_amount AS total_order_amount,
    i.invoice_amount AS total_invoice_amount,
    COALESCE(SUM(p.amount), 0) AS total_paid_amount,

    -- Order vs Invoice amount match
    CASE
        WHEN o.total_amount = i.invoice_amount THEN 'true'
        ELSE 'false'
    END AS order_invoice_match,

    -- Invoice vs Payment amount match
    CASE
        WHEN i.invoice_amount = COALESCE(SUM(p.amount), 0) THEN 'true'
        ELSE 'false'
    END AS invoice_payment_match

FROM sales_orders o
JOIN billing_invoices i
  ON i.order_id = o.order_id

LEFT JOIN billing_payments p
  ON p.invoice_id = i.invoice_id

LEFT JOIN sales_customers c
  ON c.customer_id = o.customer_id

WHERE o.status = 'COMPLETED'

GROUP BY
    c.customer_name,
    o.order_id,
    o.total_amount,
    i.invoice_amount

ORDER BY o.order_id;
```
