# Despliegue

1. **Base de datos** (una vez, dentro del MySQL existente):
   ```sql
   CREATE DATABASE recetario CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'recetario'@'%' IDENTIFIED BY 'la-misma-de-.env';
   GRANT ALL ON recetario.* TO 'recetario'@'%';
   ```
   Las tablas se crean solas al arrancar (`sequelize.sync()`).
2. `cp .env.example .env` y rellénalo (DOMAIN, MYSQL_NETWORK, DB_HOST, contraseñas, GEMINI_API_KEY).
3. Apunta el DNS de `DOMAIN` al servidor, abre los puertos 80 y 443.
4. `docker compose up -d --build`. Caddy obtiene el certificado HTTPS solo.

Respaldo: las recetas y fotos están en MySQL (`mysqldump recetario`).
Actualizar: `git pull && docker compose up -d --build`.
