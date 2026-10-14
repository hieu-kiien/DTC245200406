#!/bin/bash
# Phân quyền tối thiểu cho từng tài khoản. Chạy một lần sau khi tạo lược đồ.
#  - portfolio_app:   ứng dụng, chỉ SELECT/INSERT/UPDATE/DELETE trên CSDL portfolio
#  - portfolio_admin: dùng đăng nhập phpMyAdmin, toàn quyền trên CSDL portfolio và không có quyền nào khác
#  - exporter:        chỉ có quyền giám sát cho mysqld-exporter
#  - root:            chỉ cho phép kết nối từ trong container (localhost), xóa root@'%'
set -e
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER 'portfolio_app'@'%'   IDENTIFIED BY '${APP_DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${MYSQL_DATABASE}\`.* TO 'portfolio_app'@'%';

CREATE USER 'portfolio_admin'@'%' IDENTIFIED BY '${PMA_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO 'portfolio_admin'@'%';

CREATE USER 'exporter'@'%' IDENTIFIED BY '${EXPORTER_DB_PASSWORD}' WITH MAX_USER_CONNECTIONS 3;
GRANT PROCESS, REPLICATION CLIENT, SELECT ON *.* TO 'exporter'@'%';

DROP USER IF EXISTS 'root'@'%';
FLUSH PRIVILEGES;
SQL
