# Lane 3 — Tests (BLOCKING)

A ticket without its tests is not done. Tests land **with** the change, not in
a follow-up nobody writes.

| Check                                                                                     |                                                |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Every new entry point has a happy path, a validation failure **and an unauthorised case** |                                                |
| Every new pure function has a test with no input/output of its own                        |                                                |
| A bug fix has a regression test **written before the fix**                                | otherwise nobody knows it would have caught it |
| Every rule this project calls hard has a test asserting it still holds                    |                                                |
| Coverage did not decrease                                                                 |                                                |
| A test asserts behaviour, not implementation                                              | renaming an internal should not break it       |
| No sleeping for a fixed time — wait for a condition                                       | slow **and** flaky                             |
| End-to-end tests set up data through the API or the database, never by driving the UI     | slow, and it tests the wrong thing             |
| A skipped or focused test left behind                                                     | a green suite that runs nothing                |
| A test that passes when the code under it is deleted                                      | it asserts nothing                             |

## On end-to-end tests

Every change that crosses a boundary a user can reach needs one path exercised
end to end. Not every case — the cases belong lower down, where they are fast.
One test that proves the wiring is real, then push the detail into unit tests.

An end-to-end suite that is slow gets switched off, and a suite that is switched
off is worse than none, because everyone believes it is running.

`TESTS: PASS` or `TESTS: FAIL`
