# Apple Photo Backup
iCloud 写真データをバックアップするやつ

## Setup
以下のポリシーを持つ AWS IAM ユーザを作成し、アクセスキーを発行する。(`{S3_BUCKET}` `{S3_PREFIX}` の箇所は置き換える)

```json:AllowReadWriteToApplePhotoBackupS3Bucket
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": "arn:aws:s3:::{S3_BUCKET}",
            "Condition": {
                "StringLike": {
                    "s3:prefix": [
                        "{S3_PREFIX}*"
                    ]
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts"
            ],
            "Resource": "arn:aws:s3:::{S3_BUCKET}/{S3_PREFIX}*"
        }
    ]
}
```

`.devcontainer/compose.env.yaml` ファイルを作成する。

```yaml:.devcontainer/compose.env.yaml
services:
  workspace:
    environment:
      S3_ACCESS_KEY_ID: ...
      S3_SECRET_ACCESS_KEY: ...
      S3_REGION: ...
      S3_BUCKET: ...
      S3_PREFIX: apple-photo/
```

リポジトリを Dev Containers で開く。