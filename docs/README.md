# Orrery documentation

[English](../README.md) · [한국어](../README.ko.md)

The root READMEs introduce the product, installation, and first use. Development details and dated implementation records live here.

## Use Orrery

| Guide | Language | Read it for |
|---|---|---|
| [Product and downloads](../README.md) | English | Install, connect an AWS profile, explore the interface |
| [제품 소개와 다운로드](../README.ko.md) | 한국어 | 설치, AWS 연결, 주요 기능, 제한사항 |
| [사용 가이드](usage.ko.md) | 한국어 | 지도·필터·정리 후보·모니터링·라이브 갱신의 상세 동작 |
| [Security and privacy](security.md) | English | Local data, read-only boundaries, update trust and support |

## Build and maintain Orrery

| Guide | Language | Read it for |
|---|---|---|
| [Development](development.md) / [개발 및 패키징](development.ko.md) | English / 한국어 | Source setup, configuration, checks and builds |
| [다국어 지원](localization.md) | 한국어 | 번역 추가, 언어 저장과 데스크톱 연동, 검증 방법 |
| [구조와 보안 경계](architecture.ko.md) | 한국어 | Collectors, cache, local authentication, renderer and AWS guard |
| [자체 업데이트 운영 가이드](self-update.md) | 한국어 | Publishing releases, update transactions, backup and recovery |
| [과거 검증 기록](verification-history.ko.md) | 한국어 | Dated results and their limitations |

## Historical design and implementation records

These records preserve the decisions and tests from their stated dates. Use current product guides first. Historical credentials, permissions, costs, and approvals do not authorize new actions; environment-specific identifiers have been replaced with examples.

- [CloudWatch monitoring plan](cloudwatch-monitoring-plan.md)
- [Resource monitoring workspace](monitoring-resource-workspace-plan.md)
- [Relationship monitoring plan](plans/monitoring-relationships-2026-10-28.md)
- [Relationship monitoring implementation](monitoring-relationships-implementation-2026-10-28.md)
- [Cleanup candidate design](cleanup-candidates-plan.md)
- [Topology audit](topology-audit-2026-10-28.md)
- [Topology changes](topology-fix-2026-10-28.md)
- [Local security hardening](security-hardening.md)

## Screenshot policy

README images show the current application rendering fictional demonstration resources. They are not live customer environments or evidence of AWS health. Keep screenshots in `docs/images/`; do not include real account identifiers, resource inventories, credentials, or login URLs.
