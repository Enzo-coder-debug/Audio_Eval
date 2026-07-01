CREATE TABLE `answers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`responseId` int NOT NULL,
	`questionId` int NOT NULL,
	`answerContent` longtext NOT NULL,
	`score` decimal(5,2),
	`feedback` longtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `answers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audioFiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uploaderId` int NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`fileKey` varchar(512) NOT NULL,
	`fileUrl` varchar(1024) NOT NULL,
	`mimeType` varchar(64) NOT NULL,
	`fileSizeBytes` int NOT NULL,
	`duration` int,
	`transcription` longtext,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `audioFiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `questionnaireStats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`questionnaireId` int NOT NULL,
	`totalResponses` int NOT NULL DEFAULT 0,
	`averageScore` decimal(5,2),
	`highestScore` decimal(5,2),
	`lowestScore` decimal(5,2),
	`completionRate` decimal(5,2),
	`lastUpdated` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `questionnaireStats_id` PRIMARY KEY(`id`),
	CONSTRAINT `questionnaireStats_questionnaireId_unique` UNIQUE(`questionnaireId`)
);
--> statement-breakpoint
CREATE TABLE `questionnaires` (
	`id` int AUTO_INCREMENT NOT NULL,
	`creatorId` int NOT NULL,
	`audioFileId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`evaluationCopywriting` longtext NOT NULL,
	`scoringStandard` longtext NOT NULL,
	`status` enum('draft','published','offline') NOT NULL DEFAULT 'draft',
	`validFrom` timestamp,
	`validUntil` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`publishedAt` timestamp,
	CONSTRAINT `questionnaires_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`questionnaireId` int NOT NULL,
	`questionType` enum('single_choice','multiple_choice','subjective') NOT NULL,
	`questionText` longtext NOT NULL,
	`orderIndex` int NOT NULL,
	`options` json,
	`correctAnswers` json,
	`scoringRubric` longtext,
	`maxScore` decimal(5,2) DEFAULT '10',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `questions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `responses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`questionnaireId` int NOT NULL,
	`status` enum('in_progress','submitted','graded') NOT NULL DEFAULT 'in_progress',
	`totalScore` decimal(5,2),
	`aiComments` longtext,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`submittedAt` timestamp,
	`gradedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `responses_id` PRIMARY KEY(`id`)
);
