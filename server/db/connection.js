/**
 * 역할: better-sqlite3로 DB를 열고 외래 키 검사와 잠금 대기 시간을 설정한다.
 * 호출자가 읽기 전용 여부와 기존 DB 파일의 필수 여부를 지정할 수 있다.
 */

import Database from 'better-sqlite3';

export function openDatabase(
  databasePath,
  { readonly = false, fileMustExist = false } = {},
) {
  const database = new Database(databasePath, {
    readonly,
    fileMustExist,
  });

  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  return database;
}
