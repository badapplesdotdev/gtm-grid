# @gtmgrid/auth

## 1.7.1

### Patch Changes

- @gtmgrid/analytics@1.7.1
- @gtmgrid/db@1.7.1
- @gtmgrid/email@1.7.1

## 1.7.0

### Patch Changes

- @gtmgrid/analytics@1.7.0
- @gtmgrid/db@1.7.0
- @gtmgrid/email@1.7.0

## 1.6.1

### Patch Changes

- @gtmgrid/analytics@1.6.1
- @gtmgrid/db@1.6.1
- @gtmgrid/email@1.6.1

## 1.6.0

### Patch Changes

- @gtmgrid/analytics@1.6.0
- @gtmgrid/db@1.6.0
- @gtmgrid/email@1.6.0

## 1.5.2

### Patch Changes

- @gtmgrid/analytics@1.5.2
- @gtmgrid/db@1.5.2
- @gtmgrid/email@1.5.2

## 1.5.1

### Patch Changes

- @gtmgrid/analytics@1.5.1
- @gtmgrid/db@1.5.1
- @gtmgrid/email@1.5.1

## 1.5.0

### Patch Changes

- @gtmgrid/analytics@1.5.0
- @gtmgrid/db@1.5.0
- @gtmgrid/email@1.5.0

## 1.4.0

### Patch Changes

- @gtmgrid/analytics@1.4.0
- @gtmgrid/db@1.4.0
- @gtmgrid/email@1.4.0

## 1.3.0

### Patch Changes

- @gtmgrid/analytics@1.3.0
- @gtmgrid/db@1.3.0
- @gtmgrid/email@1.3.0

## 1.2.1

### Patch Changes

- @gtmgrid/analytics@1.2.1
- @gtmgrid/db@1.2.1
- @gtmgrid/email@1.2.1

## 1.2.0

### Patch Changes

- @gtmgrid/analytics@1.2.0
- @gtmgrid/db@1.2.0
- @gtmgrid/email@1.2.0

## 1.1.1

### Patch Changes

- @gtmgrid/analytics@1.1.1
- @gtmgrid/db@1.1.1
- @gtmgrid/email@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [3e33da9]
  - @gtmgrid/email@1.1.0
  - @gtmgrid/analytics@1.1.0
  - @gtmgrid/db@1.1.0

## 1.0.6

### Patch Changes

- @gtmgrid/analytics@1.0.6
- @gtmgrid/db@1.0.6
- @gtmgrid/email@1.0.6

## 1.0.5

### Patch Changes

- @gtmgrid/analytics@1.0.5
- @gtmgrid/db@1.0.5
- @gtmgrid/email@1.0.5

## 1.0.4

### Patch Changes

- @gtmgrid/analytics@1.0.4
- @gtmgrid/db@1.0.4
- @gtmgrid/email@1.0.4

## 1.0.3

### Patch Changes

- @gtmgrid/analytics@1.0.3
- @gtmgrid/db@1.0.3
- @gtmgrid/email@1.0.3

## 1.0.2

### Patch Changes

- @gtmgrid/analytics@1.0.2
- @gtmgrid/db@1.0.2
- @gtmgrid/email@1.0.2

## 1.0.1

### Patch Changes

- @gtmgrid/analytics@1.0.1
- @gtmgrid/db@1.0.1
- @gtmgrid/email@1.0.1

## 1.0.0

### Patch Changes

- @gtmgrid/analytics@1.0.0
- @gtmgrid/db@1.0.0
- @gtmgrid/email@1.0.0

## 0.22.12

### Patch Changes

- @gtmgrid/analytics@0.22.12
- @gtmgrid/db@0.22.12
- @gtmgrid/email@0.22.12

## 0.22.11

### Patch Changes

- @gtmgrid/analytics@0.22.11
- @gtmgrid/db@0.22.11
- @gtmgrid/email@0.22.11

## 0.22.10

### Patch Changes

- @gtmgrid/analytics@0.22.10
- @gtmgrid/db@0.22.10
- @gtmgrid/email@0.22.10

## 0.22.9

### Patch Changes

- @gtmgrid/analytics@0.22.9
- @gtmgrid/db@0.22.9
- @gtmgrid/email@0.22.9

## 0.22.8

### Patch Changes

- @gtmgrid/analytics@0.22.8
- @gtmgrid/db@0.22.8
- @gtmgrid/email@0.22.8

## 0.22.7

### Patch Changes

- @gtmgrid/analytics@0.22.7
- @gtmgrid/db@0.22.7
- @gtmgrid/email@0.22.7

## 0.22.6

### Patch Changes

- @gtmgrid/analytics@0.22.6
- @gtmgrid/db@0.22.6
- @gtmgrid/email@0.22.6

## 0.22.5

### Patch Changes

- @gtmgrid/analytics@0.22.5
- @gtmgrid/db@0.22.5
- @gtmgrid/email@0.22.5

## 0.22.4

### Patch Changes

- @gtmgrid/analytics@0.22.4
- @gtmgrid/db@0.22.4
- @gtmgrid/email@0.22.4

## 0.22.3

### Patch Changes

- Updated dependencies [fbcb535]
  - @gtmgrid/analytics@0.22.3
  - @gtmgrid/db@0.22.3
  - @gtmgrid/email@0.22.3

## 0.22.2

### Patch Changes

- 325e90b: Track new signups server-side. Better Auth account creation now captures a
  `user_signed_up` PostHog event from the `user.create.after` hook, keyed on the
  user id (the same distinct id the desktop client identifies with) and `$set`ting
  the person's email/name. Previously a signup only became an identified person if
  and when the desktop client's identify bridge ran, so accounts created without
  that (older build, analytics disabled, web/invite-only flows) stayed anonymous.
- Updated dependencies [325e90b]
  - @gtmgrid/analytics@0.22.2
  - @gtmgrid/db@0.22.2
  - @gtmgrid/email@0.22.2

## 0.22.1

### Patch Changes

- @gtmgrid/db@0.22.1
- @gtmgrid/email@0.22.1

## 0.22.0

### Patch Changes

- @gtmgrid/db@0.22.0
- @gtmgrid/email@0.22.0

## 0.21.0

### Patch Changes

- @gtmgrid/db@0.21.0
- @gtmgrid/email@0.21.0

## 0.20.1

### Patch Changes

- @gtmgrid/db@0.20.1
- @gtmgrid/email@0.20.1

## 0.20.0

### Patch Changes

- @gtmgrid/db@0.20.0
- @gtmgrid/email@0.20.0

## 0.19.1

### Patch Changes

- @gtmgrid/db@0.19.1
- @gtmgrid/email@0.19.1

## 0.19.0

### Patch Changes

- @gtmgrid/db@0.19.0
- @gtmgrid/email@0.19.0

## 0.18.0

### Patch Changes

- @gtmgrid/db@0.18.0
- @gtmgrid/email@0.18.0

## 0.17.4

### Patch Changes

- @gtmgrid/db@0.17.4
- @gtmgrid/email@0.17.4

## 0.17.3

### Patch Changes

- @gtmgrid/db@0.17.3
- @gtmgrid/email@0.17.3

## 0.17.2

### Patch Changes

- @gtmgrid/db@0.17.2
- @gtmgrid/email@0.17.2

## 0.17.1

### Patch Changes

- @gtmgrid/db@0.17.1
- @gtmgrid/email@0.17.1

## 0.17.0

### Patch Changes

- @gtmgrid/db@0.17.0
- @gtmgrid/email@0.17.0

## 0.16.2

### Patch Changes

- @gtmgrid/db@0.16.2
- @gtmgrid/email@0.16.2

## 0.16.1

### Patch Changes

- @gtmgrid/db@0.16.1
- @gtmgrid/email@0.16.1

## 0.16.0

### Patch Changes

- @gtmgrid/db@0.16.0
- @gtmgrid/email@0.16.0

## 0.15.0

### Patch Changes

- @gtmgrid/db@0.15.0
- @gtmgrid/email@0.15.0

## 0.14.0

### Patch Changes

- @gtmgrid/db@0.14.0
- @gtmgrid/email@0.14.0

## 0.13.0

### Patch Changes

- @gtmgrid/db@0.13.0
- @gtmgrid/email@0.13.0

## 0.12.0

### Patch Changes

- @gtmgrid/db@0.12.0
- @gtmgrid/email@0.12.0

## 0.11.1

### Patch Changes

- @gtmgrid/db@0.11.1
- @gtmgrid/email@0.11.1

## 0.11.0

### Patch Changes

- @gtmgrid/db@0.11.0
- @gtmgrid/email@0.11.0

## 0.10.0

### Patch Changes

- @gtmgrid/db@0.10.0
- @gtmgrid/email@0.10.0

## 0.9.24

### Patch Changes

- @gtmgrid/db@0.9.24
- @gtmgrid/email@0.9.24

## 0.9.23

### Patch Changes

- @gtmgrid/db@0.9.23
- @gtmgrid/email@0.9.23

## 0.9.22

### Patch Changes

- @gtmgrid/db@0.9.22
- @gtmgrid/email@0.9.22

## 0.9.21

### Patch Changes

- @gtmgrid/db@0.9.21
- @gtmgrid/email@0.9.21

## 0.9.20

### Patch Changes

- @gtmgrid/db@0.9.20
- @gtmgrid/email@0.9.20

## 0.9.19

### Patch Changes

- @gtmgrid/db@0.9.19
- @gtmgrid/email@0.9.19

## 0.9.18

### Patch Changes

- @gtmgrid/db@0.9.18
- @gtmgrid/email@0.9.18

## 0.9.17

### Patch Changes

- @gtmgrid/db@0.9.17
- @gtmgrid/email@0.9.17

## 0.9.16

### Patch Changes

- @gtmgrid/db@0.9.16
- @gtmgrid/email@0.9.16

## 0.9.15

### Patch Changes

- @gtmgrid/db@0.9.15
- @gtmgrid/email@0.9.15

## 0.9.14

### Patch Changes

- Updated dependencies [17ea929]
  - @gtmgrid/db@0.9.14
  - @gtmgrid/email@0.9.14

## 0.9.13

### Patch Changes

- @gtmgrid/db@0.9.13
- @gtmgrid/email@0.9.13

## 0.9.12

### Patch Changes

- @gtmgrid/db@0.9.12
- @gtmgrid/email@0.9.12

## 0.9.11

### Patch Changes

- @gtmgrid/db@0.9.11
- @gtmgrid/email@0.9.11

## 0.9.10

### Patch Changes

- @gtmgrid/db@0.9.10
- @gtmgrid/email@0.9.10

## 0.9.9

### Patch Changes

- @gtmgrid/db@0.9.9
- @gtmgrid/email@0.9.9

## 0.9.8

### Patch Changes

- @gtmgrid/db@0.9.8
- @gtmgrid/email@0.9.8

## 0.9.7

### Patch Changes

- @gtmgrid/db@0.9.7
- @gtmgrid/email@0.9.7

## 0.9.6

### Patch Changes

- @gtmgrid/db@0.9.6
- @gtmgrid/email@0.9.6

## 0.9.5

### Patch Changes

- @gtmgrid/db@0.9.5
- @gtmgrid/email@0.9.5

## 0.9.4

### Patch Changes

- @gtmgrid/db@0.9.4
- @gtmgrid/email@0.9.4

## 0.9.3

### Patch Changes

- @gtmgrid/db@0.9.3
- @gtmgrid/email@0.9.3

## 0.9.2

### Patch Changes

- @gtmgrid/db@0.9.2
- @gtmgrid/email@0.9.2

## 0.9.1

### Patch Changes

- @gtmgrid/db@0.9.1
- @gtmgrid/email@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [a6d488d]
  - @gtmgrid/db@0.9.0
  - @gtmgrid/email@0.9.0

## 0.8.0

### Patch Changes

- @gtmgrid/db@0.8.0
- @gtmgrid/email@0.8.0

## 0.7.8

### Patch Changes

- @gtmgrid/db@0.7.8
- @gtmgrid/email@0.7.8

## 0.7.7

### Patch Changes

- @gtmgrid/db@0.7.7
- @gtmgrid/email@0.7.7

## 0.7.6

### Patch Changes

- @gtmgrid/db@0.7.6
- @gtmgrid/email@0.7.6

## 0.7.5

### Patch Changes

- @gtmgrid/db@0.7.5
- @gtmgrid/email@0.7.5

## 0.7.4

### Patch Changes

- @gtmgrid/db@0.7.4
- @gtmgrid/email@0.7.4

## 0.7.3

### Patch Changes

- @gtmgrid/db@0.7.3
- @gtmgrid/email@0.7.3

## 0.7.2

### Patch Changes

- @gtmgrid/db@0.7.2
- @gtmgrid/email@0.7.2

## 0.7.1

### Patch Changes

- @gtmgrid/db@0.7.1
- @gtmgrid/email@0.7.1

## 0.7.0

### Patch Changes

- @gtmgrid/db@0.7.0
- @gtmgrid/email@0.7.0

## 0.6.1

### Patch Changes

- @gtmgrid/db@0.6.1
- @gtmgrid/email@0.6.1

## 0.6.0

### Patch Changes

- @gtmgrid/db@0.6.0
- @gtmgrid/email@0.6.0

## 0.5.1

### Patch Changes

- @gtmgrid/db@0.5.1
- @gtmgrid/email@0.5.1

## 0.5.0

### Patch Changes

- @gtmgrid/db@0.5.0
- @gtmgrid/email@0.5.0

## 0.4.0

### Patch Changes

- @gtmgrid/db@0.4.0
- @gtmgrid/email@0.4.0

## 0.3.18

### Patch Changes

- @gtmgrid/db@0.3.18
- @gtmgrid/email@0.3.18

## 0.3.17

### Patch Changes

- @gtmgrid/db@0.3.17
- @gtmgrid/email@0.3.17

## 0.3.16

### Patch Changes

- @gtmgrid/db@0.3.16
- @gtmgrid/email@0.3.16

## 0.3.15

### Patch Changes

- @gtmgrid/db@0.3.15
- @gtmgrid/email@0.3.15

## 0.3.14

### Patch Changes

- @gtmgrid/db@0.3.14
- @gtmgrid/email@0.3.14

## 0.3.13

### Patch Changes

- @gtmgrid/db@0.3.13
- @gtmgrid/email@0.3.13

## 0.3.12

### Patch Changes

- @gtmgrid/db@0.3.12
- @gtmgrid/email@0.3.12

## 0.3.11

### Patch Changes

- @gtmgrid/db@0.3.11
- @gtmgrid/email@0.3.11

## 0.3.10

### Patch Changes

- @gtmgrid/db@0.3.10
- @gtmgrid/email@0.3.10

## 0.3.9

### Patch Changes

- @gtmgrid/db@0.3.9
- @gtmgrid/email@0.3.9

## 0.3.8

### Patch Changes

- @gtmgrid/db@0.3.8
- @gtmgrid/email@0.3.8

## 0.3.7

### Patch Changes

- @gtmgrid/db@0.3.7
- @gtmgrid/email@0.3.7

## 0.3.6

### Patch Changes

- @gtmgrid/db@0.3.6
- @gtmgrid/email@0.3.6

## 0.3.5

### Patch Changes

- @gtmgrid/db@0.3.5
- @gtmgrid/email@0.3.5

## 0.3.4

### Patch Changes

- @gtmgrid/db@0.3.4
- @gtmgrid/email@0.3.4

## 0.3.3

### Patch Changes

- @gtmgrid/db@0.3.3
- @gtmgrid/email@0.3.3

## 0.3.2

### Patch Changes

- @gtmgrid/db@0.3.2
- @gtmgrid/email@0.3.2

## 0.3.1

### Patch Changes

- @gtmgrid/db@0.3.1
- @gtmgrid/email@0.3.1

## 0.3.0

### Patch Changes

- @gtmgrid/db@0.3.0
- @gtmgrid/email@0.3.0
