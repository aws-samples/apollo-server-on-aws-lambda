import { APIGatewayEvent } from 'aws-lambda';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';

import { generateLambdaProxyResponse } from './utils';

const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const dynamoDbClient: DocumentClient = new AWS.DynamoDB.DocumentClient({
  apiVersion: '2012-08-10',
  region: process.env.AWS_REGION,
});

export async function connectionHandler(event: APIGatewayEvent): Promise<any> {
  const { eventType, connectionId } = event.requestContext;

  if (eventType === 'CONNECT') {
    // Ignore, since we only care about subscriptions
    return generateLambdaProxyResponse(200, 'Connected');
  }

  if (eventType === 'DISCONNECT') {
    const { Items: connections } = await dynamoDbClient.query({
      TableName: process.env.TABLE_NAME!,
      IndexName: process.env.GSI_NAME!,
      KeyConditionExpression: 'connectionId = :cId',
      ExpressionAttributeValues: {
        ':cId': connectionId,
      },
      ProjectionExpression: 'chatId',
    }).promise();

    // Consider using .batchWrite(..) for production use cases.
    // This POC uses .delete(..) to not have to deal with the batch size limit of 25
    const deleteOperations = connections?.map((item) => dynamoDbClient.delete({
      TableName: process.env.TABLE_NAME!,
      Key: {
        connectionId,
        chatId: item.chatId,
      },
    }).promise());

    await Promise.allSettled(deleteOperations ?? []);

    return generateLambdaProxyResponse(200, 'Disconnected');
  }

  return generateLambdaProxyResponse(200, 'Ok');
}
