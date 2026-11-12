import { Sequelize, DataTypes as T } from 'sequelize';

export async function initDb() {
  const { DB_HOST, DB_PORT = 3306, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
  const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
    host: DB_HOST,
    port: +DB_PORT,
    dialect: 'mysql',
    logging: false,
    define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
  });

  const Ingredient = sequelize.define('Ingredient', {
    id: { type: T.STRING(32), primaryKey: true },
    name: { type: T.STRING(120), allowNull: false },
    price: { type: T.DOUBLE, allowNull: false, defaultValue: 0 },
    qty: { type: T.DOUBLE, allowNull: false, defaultValue: 1 },
    unit: { type: T.STRING(4), allowNull: false },
  });

  const Photo = sequelize.define(
    'Photo',
    {
      id: { type: T.STRING(32), primaryKey: true },
      mime: { type: T.STRING(40), allowNull: false },
      data: { type: T.BLOB('medium'), allowNull: false },
      recipeId: { type: T.STRING(32), allowNull: true }, // null = uploaded but not saved with a recipe yet
    },
    { updatedAt: false, indexes: [{ fields: ['recipeId'] }] }
  );

  const Recipe = sequelize.define('Recipe', {
    id: { type: T.STRING(32), primaryKey: true },
    name: { type: T.STRING(160), allowNull: false },
    coverId: { type: T.STRING(32), allowNull: true },
    yield: { type: T.DOUBLE, allowNull: false, defaultValue: 1 },
    yieldUnit: { type: T.STRING(12), allowNull: false, defaultValue: 'porciones' },
    salePrice: { type: T.DOUBLE, allowNull: false, defaultValue: 0 },
    other: { type: T.DOUBLE, allowNull: false, defaultValue: 0 },
  });

  const RecipeItem = sequelize.define(
    'RecipeItem',
    {
      qty: { type: T.DOUBLE, allowNull: false, defaultValue: 0 },
      unit: { type: T.STRING(4), allowNull: false },
      position: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { timestamps: false }
  );

  const RecipeStep = sequelize.define(
    'RecipeStep',
    {
      text: { type: T.TEXT, allowNull: false },
      photoId: { type: T.STRING(32), allowNull: true },
      position: { type: T.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { timestamps: false }
  );

  const Setting = sequelize.define('Setting', { key: { type: T.STRING(40), primaryKey: true }, value: T.TEXT }, { timestamps: false });

  Recipe.hasMany(RecipeItem, { as: 'items', foreignKey: { name: 'recipeId', allowNull: false }, onDelete: 'CASCADE' });
  Recipe.hasMany(RecipeStep, { as: 'steps', foreignKey: { name: 'recipeId', allowNull: false }, onDelete: 'CASCADE' });
  RecipeItem.belongsTo(Ingredient, { foreignKey: { name: 'ingredientId', allowNull: false }, onDelete: 'RESTRICT' });

  // Wait for MySQL (the container may still be starting).
  for (let i = 1; ; i++) {
    try {
      await sequelize.authenticate();
      break;
    } catch (e) {
      if (i >= 30) throw e;
      console.log(`Esperando a MySQL (${i}/30): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await sequelize.sync(); // creates missing tables; never alters existing ones
  // Small manual migrations for columns added after the first release.
  const qi = sequelize.getQueryInterface();
  const recipeCols = await qi.describeTable('Recipes');
  if (!recipeCols.yieldUnit) {
    await qi.addColumn('Recipes', 'yieldUnit', { type: T.STRING(12), allowNull: false, defaultValue: 'porciones' });
    console.log('Migración: columna Recipes.yieldUnit agregada');
  }

  return { sequelize, Ingredient, Photo, Recipe, RecipeItem, RecipeStep, Setting };
}
