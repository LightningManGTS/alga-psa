// Rolling-release compatibility for databases that recorded the retired
// split-audience migration. Fresh installations must not recreate its templates,
// and rolling back must not remove historical data.
exports.config = { transaction: false };

exports.up = async function up() {};
exports.down = async function down() {};
