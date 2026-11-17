CREATE TABLE IF NOT EXISTS rooms (
    id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('waiting', 'active') NOT NULL DEFAULT 'waiting',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_rooms_status_created (status, created_at)
) ENGINE=InnoDB;
