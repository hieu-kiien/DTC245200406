-- Lược đồ cơ sở dữ liệu portfolio. Chạy một lần khi volume dữ liệu còn trống.
CREATE TABLE admins (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(32)  NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE profile (
  id         TINYINT PRIMARY KEY,
  full_name  VARCHAR(80)  NOT NULL,
  headline   VARCHAR(200) NOT NULL DEFAULT '',
  about      TEXT         NOT NULL,
  email      VARCHAR(120) NOT NULL DEFAULT '',
  github_url VARCHAR(300) NOT NULL DEFAULT '',
  location   VARCHAR(80)  NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE skills (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  category   VARCHAR(40) NOT NULL,
  name       VARCHAR(60) NOT NULL,
  sort_order INT NOT NULL DEFAULT 50
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE projects (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  title      VARCHAR(120) NOT NULL,
  summary    TEXT         NOT NULL,
  stack      VARCHAR(200) NOT NULL DEFAULT '',
  repo_url   VARCHAR(300) NOT NULL DEFAULT '',
  demo_url   VARCHAR(300) NOT NULL DEFAULT '',
  year       SMALLINT NULL,
  published  TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 10
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(80)  NOT NULL,
  email      VARCHAR(120) NOT NULL,
  body       TEXT         NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at    TIMESTAMP    NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
