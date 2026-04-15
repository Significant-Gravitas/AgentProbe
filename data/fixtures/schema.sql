-- Schema for Internal Admin Panel

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tables
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'support', 'analyst')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID NOT NULL, -- The user performing the action (from Clerk metadata/session)
    action_type VARCHAR(20) NOT NULL CHECK (action_type IN ('INSERT', 'UPDATE', 'DELETE')),
    target_table VARCHAR(50) NOT NULL,
    target_id UUID NOT NULL,
    old_value JSONB,
    new_value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_audit_log_target ON audit_log(target_table, target_id);

-- Seed Data
INSERT INTO users (id, email, role) VALUES 
('01946891-9892-7472-8874-9b51909a304e', 'admin@company.com', 'admin'),
('01946891-9892-7472-8874-9b51909a304f', 'support-staff@company.com', 'support'),
('01946891-9892-7472-8874-9b51909a3050', 'analyst-team@company.com', 'analyst'),
('01946891-9892-7472-8874-9b51909a3051', 'customer1@external.com', 'analyst'); -- External users treated as read-only or handled by support

INSERT INTO products (sku, name, price_cents, stock) VALUES 
('WGT-001', 'Super Widget', 2500, 150),
('GIZ-999', 'Turbo Gizmo', 12550, 42),
('SPR-500', 'Replacement Spring', 499, 1200);

INSERT INTO orders (user_id, status, total_cents) VALUES 
('01946891-9892-7472-8874-9b51909a3051', 'delivered', 2999),
('01946891-9892-7472-8874-9b51909a3051', 'pending', 12550);
