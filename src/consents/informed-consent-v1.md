---
name: informed-consent
version: 1
requires_signature: true
title: Information and Consent for Treatment
required_fields:
  - { key: gender, label: "Which of the following most accurately describes you (choose as many as you like)?", kind: choice_multi, required: true, options: [Female, Male, Non-binary, Transgender, Intersex, Prefer not to say, Other] }
  - { key: gender_other, label: "Other (please specify)", kind: text, required: false }
  - { key: pronouns, label: "What are your pronouns (choose as many as you like)?", kind: choice_multi, required: true, options: [She/her, He/him, They/them, Prefer not to say, Other] }
  - { key: pronouns_other, label: "Other (please specify)", kind: text, required: false }
  - { key: npp_acknowledged, label: "I acknowledge I received the Notice of Privacy Practices ({{npp_version_label}}).", kind: checkbox, required: true }
  - { key: voicemail_permission, label: "I give permission for messages to be left on my telephone voicemail for purposes of scheduling and communication.", kind: yesno, required: true }
  - { key: voicemail_phone, label: "Phone number for voicemail", kind: text, required: false }
  - { key: voicemail_instructions, label: "Special instructions for phone messages", kind: longtext, required: false }
  - { key: email_permission, label: "I give permission for email to be sent to me for purposes of scheduling and communication.", kind: yesno, required: true }
  - { key: email_address, label: "Email address", kind: text, required: false }
  - { key: email_instructions, label: "Special instructions for emails", kind: longtext, required: false }
  - { key: questions_resolved, label: "I have had the opportunity to resolve any questions about these conditions of treatment.", kind: yesno, required: true }
  - { key: copy_received, label: "I have received (or can print) a copy of this form for my own records.", kind: yesno, required: true }
  - { key: client_name, label: "Client Name", kind: text, required: true }
  - { key: client_dob, label: "Client Date of Birth", kind: date, required: true }
  - { key: client_address, label: "Client Address", kind: longtext, required: true }
  - { key: age_or_guardian_attestation, label: "I am at least 18 years of age and submitting this form on behalf of myself, or of a minor for whom I have the legal authority to obtain this treatment.", kind: yesno, required: true }
  - { key: guardian_name, label: "If signed by a legal guardian on behalf of a minor, please enter their name", kind: text, required: false }
  - { key: guardian_authority, label: "If signed by a legal guardian on behalf of a minor, please describe your authority to act for them", kind: longtext, required: false }
  - { key: signature_data_url, label: "Signature of Client or Personal Representative", kind: signature, required: true }
  - { key: signature_date, label: "Signature date", kind: date, required: true }
---

# Information and Consent for Treatment

This document contains important information about our professional services and business policies. It also contains a summary of information about the Health Insurance Portability and Accountability Act (HIPAA), a federal law that provides privacy protections and patient rights about the use and disclosure of your Protected Health Information (PHI) for the purposes of treatment, payment, and health care operations. Although these documents are long and sometimes complex, it is very important that you understand them. When you sign this document, it will also represent an agreement between us. We can discuss any questions you have when you sign or at any time in the future.

## Psychological Services

Therapy is a relationship between people that works largely because of the clearly defined rights and responsibilities held by each person. As a client in psychotherapy, you have certain rights and responsibilities that are important for you to understand. There are also legal limitations to those rights. Your therapist also has corresponding responsibilities to you. These rights and responsibilities are described in the following sections.

Psychotherapy has both benefits and risks. Risks may include experiencing uncomfortable feelings, such as sadness, guilt, anxiety, anger, frustration, loneliness and helplessness, because the process of psychotherapy often requires discussing the unpleasant aspects of your life. However, psychotherapy has been shown to have benefits for individuals who undertake it. Therapy often leads to a significant reduction in feelings of distress, increased satisfaction in interpersonal relationships, greater personal awareness and insight, increased skills for managing stress and resolutions to specific problems. But, there are no guarantees about what will happen. Psychotherapy requires a very active effort on your part. In order to be most successful, you will have to continue working on the things that we discuss outside of your session.

Even successful treatment might involve emotionally painful moments, and/or a period of post-treatment distress as you adjust to the changes you have made. Trauma therapy also entails a risk of destabilization if a memory is opened up and activated but not resolved. While post-treatment risk is much lower in intensive (compared to hour-per-week) therapy, it still exists. This risk can be further minimized/mitigated by:

- Being truthful in the telephone screening, so the interviewer does not underestimate your symptoms or your history of exposure to traumatic events
- Completing the full recommended course of treatment, so that whatever gets opened up or activated can fully processed and released
- Practicing self-regulation strategies

The first half of day 1 will involve a comprehensive evaluation of your needs. By the end of the evaluation, we will be able to offer you some initial impressions of what our work might include. At that point, we will discuss your treatment goals and create an initial treatment plan. You should evaluate this information and make your own assessment about whether you feel comfortable moving forward. If you have questions about any of our procedures, we should discuss them whenever they arise.

## Treatment Methods

The treatment approaches feature Eye Movement Desensitization & Reprocessing (EMDR), and Accelerated Resolution Therapy (ART), which are trauma-informed bilateral stimulation therapies. Depending on your therapist, they may also incorporate additional modalities, including, but not limited to: Internal Family Systems Therapy (IFS), Image Transformation Therapy (ImTT), and numerous other modalities that are known and respected in the therapeutic community.

All therapists have been trained and certified in EMDR and utilize an intensive trauma therapy model. If it becomes clear that this model is not a good fit, we will discuss this with you and may provide recommendations for how to proceed with treatment in your community.

## Treatment Effectiveness

Your therapist is responsible for providing evaluative information about your situation and for making recommendations. You are responsible for determining the suitability of the various options and making your own choice. Your therapist will be using effective, efficient research-supported methods whenever appropriate in their judgment. However, regardless of treatment format and treatment activities, every person and situation is unique, and treatment results are not guaranteed.

## Voluntary Engagement

Not every person/situation is appropriate for a given treatment format, and a given therapist is not right for every client. You can terminate the treatment relationship at any time; you are under no obligation to engage in or persist in treatment. Other treatment options are available to you whether at a distance or in your own location, and no treatment is also an option. Engaging in treatment may involve discussing uncomfortable or distressing topics on some occasions. Not engaging in treatment may be more comfortable in the short run, but then you will not have professional guidance in achieving your goals.

## Reservations

Retreat reservations are booked for full days (up to 6 hours of therapy) and/or half days (up to 3 hours of therapy). The days and times reserved for your retreat are for you and you alone.

## Professional Fees & Payment Methods

Your therapist for this retreat is **{{therapist_name}}**. The rate agreed upon for your retreat is:

- Full day (up to 6 hours): **{{full_day_rate_formatted}}**
{{#if half_day_rate_formatted}}
- Half day (up to 3 hours): **{{half_day_rate_formatted}}**
{{/if}}

Accepted payment methods are credit card, debit card and instant ACH bank transfer.

We also offer payment plans from 6 to 36 months through our third-party provider Affirm for a **{{affirm_uplift_pct_formatted}}** increase above the standard rate. All terms and details related to the fulfillment of your payment plan are handled by Affirm and will be shared with you at the time of your loan application.

Please note that we charge in blocks of full days and half days and do not give refunds for hours that are not attended. {{#if half_day_rate_formatted}}For example, a half day (up to 3 hours) that is attended for 2 hours will be billed at the half-day rate of {{half_day_rate_formatted}} (or {{half_day_rate_affirm_formatted}} through Affirm). {{/if}}We encourage clients to utilize all of the time that is reserved for them to gain the maximum benefits from their retreat experience.

In addition, your therapist may offer other professional services that you may require, such as report writing, telephone conversations that last longer than 15 minutes, attendance at meetings or consultations which you have requested, and/or the time required to perform any other services which you may request. These services will be offered on an hourly basis. If you anticipate becoming involved in a court case, we recommend that you discuss this fully before you waive your right to confidentiality. If your case requires your therapist's participation, you will be expected to pay for the professional time required, even if another party compels your therapist to testify.

## Insurance

Intensive trauma treatment is currently not covered by insurance. You are responsible for full payment of the fee.

## Deposits, Cancellations & Refund of Deposits

For self-pay clients, there is a deposit of one full day (**{{deposit_rate_formatted}}**) required to secure your intensive therapy retreat payable via credit card, debit card or instant ACH bank transfer.

If you are approved for a payment plan through Affirm, you must pay your entire retreat balance up front to reserve your dates.

If you need to cancel, we ask that you provide us with as much advance notice as possible.

Cancellations prior to 3 weeks before your scheduled retreat are accepted, and you will receive a partial refund (your deposit minus a **{{cancellation_admin_fee_formatted}}** fee to cover administrative costs). Cancellations for any reason within 3 weeks or less of your scheduled start date will result in a forfeit of your deposit.

## Final Payment

If you have paid your retreat deposit by credit card, debit card or instant ACH bank transfer, you will be billed automatically at the end of your retreat for the remaining amount due. You will not receive prior notification of this charge.

If you are approved for a payment plan through Affirm, you will not be charged again at the end of your retreat. If for any reason your retreat turns out to be shorter than the days you have reserved, you will be refunded directly to your loan balance through Affirm.

## No-Show & Late Policy

The scheduling of an intensive therapy retreat involves the reservation of a block of time set aside for you only, to provide you with the highest quality care. If you miss a day, or part of a day, for any reason, our policy is to collect the full day's pay. You will be responsible for this portion of the fee as described above.

In addition, you are responsible for coming to your session on time. If you are late, your appointment will still need to end on time and you will be billed the full amount for that day.

## Rescheduling Policy

We do understand that unexpected situations may arise. In the event of an illness or another unforeseen circumstance that prevents the retreat from occurring, we will do our best to reschedule.

## Collections

It is our policy to collect all remaining fees at the completion of service. All accounts that are not paid within thirty (30) days from the final date of service shall be considered past due.

Please be advised that we may seek payment for your unpaid amount with the assistance of a collections agency or civil court action. Should this occur, we will provide the collection agency or court with your name, address and phone number, as well as dates of service and any other information that is deemed necessary to collect the past due amount. We will never disclose any records detailing your psychological services.

Please note that we will make all attempts possible to reach you directly using the communication methods you have provided to us before resorting to collections. If we must send your account to collections, we will notify you of our intention to do so by sending an email to the address on file. Please note that you will be responsible for any additional costs incurred in the process of collecting the past due amount.

## Professional Records

Your therapist is required to keep appropriate records of the psychological services that they provide to you. Your records are maintained in a secure location within your therapist's office. In general, your therapist will keep brief records noting that you were in attendance, your reasons for seeking therapy, the goals and progress you have set for treatment, your diagnosis, topics that have been discussed, your medical, social, and treatment history, records they have received from other providers, copies of records that they send to others, and your billing records.

Except in unusual circumstances that involve danger to yourself, you have the right to a copy of your file. Because these are professional records, they may be misinterpreted and/or upsetting to untrained readers. For this reason, if you request a copy, we recommend that you initially review them with your therapist, or have them forwarded to another mental health professional to discuss the contents. If your therapist refuses your request for access to your records, you have a right to have their decision reviewed by another mental health professional, which will be discussed with you upon your request. You also have the right to request that a copy of your file be made available to any other health care provider at your written request.

## Security

Your therapist is responsible for securing your records according to current standards. You are responsible for the security of your own telephone, answering machine, and computer. It is understood that the security of emails cannot be guaranteed. It is thus recommended that sensitive material (such as personal disclosures) not be delivered through email. However, emails can be useful in confirming appointment times and related details, minimizing the risk of misunderstandings or missed appointments.

## Confidentiality

Our policies about confidentiality, as well as other information about your privacy rights, are fully described in a separate document entitled Notice of Privacy Practices. You have been provided with a copy of that document. Please remember that you may reopen the conversation at any time while working with your therapist.

Everything you say, and all information about you, will be kept confidential with the following exceptions:

- Your therapist may share selected information with a given person/agency to the extent that you give explicit permission to share it
- Information such as charges and dates of services will be communicated (to financial institutions or others) as necessary to process payments and/or collections
- Your therapist is legally mandated to report to the authorities anticipated danger to self or others as well as suspected abuse, neglect or exploitation of vulnerable parties such as children or elders
- Your therapist may on occasion be required to disclose information as per a judge's order
- Your therapist is permitted to disclose information as necessary in defense of a proceeding brought against them
- Non-identifying information about you may be used for quality assurance, treatment evaluation, and other service monitoring and/or research purposes
- If you should encounter your therapist in another context, they will not initiate contact. To protect your confidentiality, it will be your choice whether or not to acknowledge or initiate an interaction with them.

## Contacting Your Therapist

Your therapist is often not immediately available by telephone. Therapists will not answer while with clients or otherwise unavailable. At these times, you may leave a message on their confidential voicemail and your call will be returned as soon as possible, but it may take a day or two for non-urgent matters. If, for any reason, you do not hear from your therapist or they are unable to reach you, and you feel you cannot wait for a return call or you feel unable to keep yourself safe:

1. Contact Crisis Services in your local area
2. Go to your Local Hospital Emergency Room, or
3. Call 911 and ask to speak to the mental health worker on call

## Other Rights

If you are unhappy with what is happening in therapy, we encourage you to talk with your therapist so that they have the opportunity to respond to your concerns. Such comments will be taken seriously and handled with care and respect. You may also request that your therapist refer you to another therapist and are free to end therapy at any time. You have the right to considerate, safe and respectful care, without discrimination as to race, ethnicity, color, gender, sexual orientation, age, religion, national origin, or source of payment. You have the right to ask questions about any aspect of therapy and about my specific training and experience. You have the right to expect that your therapist will not have social or sexual relationships with clients or with former clients.

## Post-Treatment Support

We may plan a follow-up check-in after your retreat, which may (or may not) lead to additional check-ins, additional treatment, or referral. Other than this follow-up, your therapist will not be available to you for ongoing support after the retreat is completed. If you have stated that you are currently working with a therapist, you will be relying on your current therapist for any needed support or stabilization following the therapy retreat.

While we do not require clients to have an individual therapist prior to attending a retreat, it is strongly encouraged that you have a therapist who can work with you upon retreat completion to continue your trauma processing and solidify treatment gains. Most clients benefit greatly from this approach.

## Stability and Behaviors

You affirm that you are not actively suicidal or dangerous to yourself, to other people, or to property. You affirm that you will not become drunk, high, or otherwise under the influence of drugs for the 3 days prior to the start and entire duration of the retreat.

## Legal Issues

You understand that being in treatment may impact outcomes of any legal case that may be related to the focus of treatment. For example, if your symptoms decrease, you may not get as much sympathy (or award) from a judge or jury. On the other hand, if you are better able to talk about what happened, you may present more effectively in court. You understand that it is your responsibility to consult with your attorney about these issues, and then to make your own decision about whether or not to proceed with treatment.

## Communications

Use of email and voicemail allows therapists to exchange information efficiently for the benefit of our clients. At the same time, we recognize that email is not a completely secure means of communication because messages can be addressed to the wrong person or accessed improperly while in storage or during transmission. Similarly, detailed voicemail messages allow your therapist to provide information to you in a timely manner but if the voicemail system is shared, the information could be heard by others.

If you would like to authorize your therapist to send you email or leave detailed voicemails that contain your health information, please indicate your choices on the page below. You are not required to authorize the use of email and/or voicemail and a decision not to sign this authorization will not affect your care in any way. If you prefer not to authorize the use of email and/or voicemail, we will use U.S. Mail or telephone to communicate with you.

## Consent to Treatment

I understand that signing my name below will indicate my understanding and agreement with the stated conditions of treatment.

My signature below indicates that I have read and understood this Agreement and the Notice of Privacy Practices ({{npp_version_label}}) and agree to their terms.
