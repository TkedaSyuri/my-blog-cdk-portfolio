const AWS = require("aws-sdk");
const secretsManager = new AWS.SecretsManager();

exports.handler = async (event) => {
const { DB_ENDPOINT, SECRET_ID } = event;
  try {
    const currentSecret = await secretsManager.getSecretValue({ SecretId: SECRET_ID }).promise();
    const secretObject = JSON.parse(currentSecret.SecretString);
    secretObject.host = DB_ENDPOINT;

    await secretsManager.updateSecret({
      SecretId: SECRET_ID,
      SecretString: JSON.stringify(secretObject),
    }).promise();

    console.log("Updated host to:", DB_ENDPOINT);
  } catch (err) {
    console.error("Error updating secret:", err);
    throw err;
  }
};
