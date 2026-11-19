import os, boto3

sqs = boto3.client('sqs', region_name=os.environ.get('AWS_REGION', 'us-east-1'),
                    aws_access_key_id=os.environ['AWS_ACCESS_KEY_ID'],
                    aws_secret_access_key=os.environ['AWS_SECRET_ACCESS_KEY'])
url = os.environ['SQS_QUEUE_URL']
attrs = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=['All'])['Attributes']
for k in ('ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'MessageRetentionPeriod', 'CreatedTimestamp'):
    print(k, '=', attrs.get(k))
