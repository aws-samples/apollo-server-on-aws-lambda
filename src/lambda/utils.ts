/**
 * Generates a object that is compatible with Lambda Proxy integration
 */
export function generateLambdaProxyResponse(httpCode: number, jsonBody: string) {
  return {
    body: jsonBody,
    statusCode: httpCode,
  };
}

/**
 * Apollo requires certain fields to properly process the request.
 * They are already set if the Lambda function is invoked by a REST API, but are missing in WS APIs.
 * We deep clone the event to avoid any side effects before adding the fields
 */
export function generateApolloCompatibleEventFromWebsocketEvent(event: any): any {
  const deepClonedEvent = JSON.parse(JSON.stringify(event));
  deepClonedEvent.resource = '/';
  deepClonedEvent.path = '/';
  deepClonedEvent.httpMethod = 'POST';
  deepClonedEvent.multiValueHeaders = { 'Content-Type': 'application/json' };
  delete deepClonedEvent.headers;

  return deepClonedEvent;
}
